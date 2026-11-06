import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc, desc, eq } from "@arkiv-network/sdk/query";
import { defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  EVENT_LIST_LIMIT,
  isAccount,
  isEvent,
  keptName,
  keptPicture,
  newestFirst,
  oldestFirst,
  StoreError,
  type EventSeal,
  type PassSeal,
  type PictureRecord,
  type RecordStore,
  type SealRecord,
} from "@/lib/records";
import { isSealHash } from "@/lib/world";

/**
 * One authorised seal on Arkiv. Every column is indexed, because each one is something a reader
 * looks up by: the seal, the person's pass, the account, the kind of check, the time, and the
 * person's name at a desk, and the event. The name and the event are left out when there is none,
 * as in records kept before them.
 */
export const Seals = defineSchema("blank-demo.seals", {
  hash: str().indexed(),
  pass: str().indexed(),
  account: str().indexed(),
  credential: str().indexed(),
  at: u64().indexed(),
  name: str().indexed().optional(),
  event: str().indexed().optional(),
});

/**
 * The pointer to one seal's picture on Arkiv, an entity of its own because a seal's record is
 * read-only. Looked up by the seal and by the event, and ordered by time, so those are indexed;
 * the Swarm reference, the file's SHA-256 and its size are only read back. The size is kept as
 * `size`, since `bytes` is a word of the query language. The event is left out when the seal's
 * record names none.
 */
export const Pictures = defineSchema("blank-demo.pictures", {
  hash: str().indexed(),
  event: str().indexed().optional(),
  at: u64().indexed(),
  ref: str(),
  sha256: str(),
  size: u64(),
});

// A record outlives the event by weeks, but is not kept forever.
export const RECORD_LIFETIME_DAYS = 30;

/** The most rows the node returns in one page. */
const PAGE_SIZE = 100;

export type ArkivSettings = {
  /** The wallet that writes every record. Only records it created, read-only, are believed. */
  creator: Address;
  /** The writing wallet's key; absent on a server that only reads. */
  privateKey: Hex | null;
  accessKey: string;
};

/**
 * Reads the Arkiv settings from the environment. Null when neither ARKIV_PRIVATE_KEY nor
 * ARKIV_OWNER (the address of the writing wallet, to read only) is set. Throws a StoreError when
 * one is set but is not well formed, so a typo never quietly falls back to another store.
 */
export function arkivSettings(): ArkivSettings | null {
  const key = process.env.ARKIV_PRIVATE_KEY ?? "";
  const owner = process.env.ARKIV_OWNER ?? "";
  const accessKey = process.env.ARKIV_ACCESS_KEY ?? "";
  if (key !== "") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new StoreError();
    const privateKey = key as Hex;
    return { creator: privateKeyToAccount(privateKey).address, privateKey, accessKey };
  }
  if (owner !== "") {
    if (!isAddress(owner)) throw new StoreError();
    return { creator: getAddress(owner), privateKey: null, accessKey };
  }
  return null;
}

/** What every row is read with: who created it, how, and when. */
type Provenance = {
  $key: Hex;
  $creator: Hex;
  $creationFlags: { readonly: boolean };
  $createdAt: bigint;
};

const PROVENANCE = {
  $key: true,
  $creator: true,
  $creationFlags: true,
  $createdAt: true,
} as const;

/**
 * Whether a row may be believed: created by our wallet, and created read-only, so no one has
 * changed it since. Its owner is not asked: ownership can be handed to us without our consent.
 */
function trusted(row: Provenance, creator: Address): boolean {
  return row.$creator.toLowerCase() === creator.toLowerCase() && row.$creationFlags.readonly;
}

/**
 * Earliest created first: by the block it was created in, which the writer does not choose, then
 * by key. The node can neither filter nor sort on the creation block, so this is done here.
 */
function byCreation(a: Provenance, b: Provenance): number {
  if (a.$createdAt !== b.$createdAt) return a.$createdAt < b.$createdAt ? -1 : 1;
  return a.$key < b.$key ? -1 : a.$key > b.$key ? 1 : 0;
}

type Row = Provenance & {
  hash: { value: string };
  pass: { value: string };
  account: { value: string };
  credential: { value: string };
  at: { value: bigint };
  name?: { value: string };
  event?: { value: string };
};

const SEAL_COLUMNS = {
  ...PROVENANCE,
  hash: true,
  pass: true,
  account: true,
  credential: true,
  at: true,
  name: true,
  event: true,
} as const;

/** A row as a record, or null if it does not say what a record must. */
function toRecord(row: Row): SealRecord | null {
  const credential = row.credential.value;
  if (credential !== "human" && credential !== "selfie") return null;
  const ms = Number(row.at.value);
  if (!Number.isSafeInteger(ms)) return null;
  const account = row.account.value;
  return {
    hash: row.hash.value,
    pass: row.pass.value,
    credential,
    account: isAccount(account) ? account : null,
    name: keptName(row.name?.value),
    event: isEvent(row.event?.value) ? (row.event?.value as string) : null,
    at: new Date(ms).toISOString(),
  };
}

type PictureRow = Provenance & {
  hash: { value: string };
  event?: { value: string };
  at: { value: bigint };
  ref: { value: string };
  sha256: { value: string };
  size: { value: bigint };
};

const PICTURE_COLUMNS = {
  ...PROVENANCE,
  hash: true,
  event: true,
  at: true,
  ref: true,
  sha256: true,
  size: true,
} as const;

/** A row as a picture pointer, or null if it does not say what a pointer must. */
function toPicture(row: PictureRow): PictureRecord | null {
  const ms = Number(row.at.value);
  if (!Number.isSafeInteger(ms)) return null;
  return keptPicture(
    {
      hash: row.hash.value,
      event: row.event?.value ?? null,
      ref: row.ref.value,
      sha256: row.sha256.value,
      bytes: Number(row.size.value),
      at: new Date(ms).toISOString(),
    },
    row.hash.value,
  );
}

/** The first row per seal, in order of creation. */
function firstPerSeal<T extends Provenance & { hash: { value: string } }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return [...rows].sort(byCreation).filter((row) => {
    if (seen.has(row.hash.value)) return false;
    seen.add(row.hash.value);
    return true;
  });
}

/**
 * Keeps each record as an entity on Arkiv's testnet, created read-only by the server's wallet.
 * Anyone may write an entity that looks like ours, and may hand it to our wallet, so every read
 * asks only for entities our wallet created, and believes only those created read-only: no one,
 * the creator included, can change such an entity after the fact.
 */
export class ArkivStore implements RecordStore {
  private readonly chain;
  private readonly reader;
  private readonly pending = new Map<string, Promise<SealRecord>>();
  private readonly pendingPictures = new Map<string, Promise<PictureRecord>>();

  constructor(private readonly settings: ArkivSettings) {
    this.chain = rabdi({ accessKey: settings.accessKey });
    this.reader = createPublicClient({ chain: this.chain, transport: http(), cacheTime: 0 });
  }

  private seals() {
    return this.reader.select(SEAL_COLUMNS).from(Seals).createdBy(this.settings.creator);
  }

  private pictures() {
    return this.reader.select(PICTURE_COLUMNS).from(Pictures).createdBy(this.settings.creator);
  }

  private believed<T extends Provenance>(rows: readonly unknown[]): T[] {
    return (rows as T[]).filter((row) => trusted(row, this.settings.creator));
  }

  private async rows(hash: string): Promise<Row[]> {
    try {
      const page = await this.seals()
        .where(eq("hash", hash))
        .orderBy(asc("$key"))
        .limit(PAGE_SIZE)
        .fetch();
      return this.believed<Row>(page.entities).filter((row) => row.hash.value === hash);
    } catch (error) {
      throw new StoreError(error);
    }
  }

  async get(hash: string): Promise<SealRecord | null> {
    for (const row of (await this.rows(hash)).sort(byCreation)) {
      const record = toRecord(row);
      if (record) return record;
    }
    return null;
  }

  async byPass(pass: string): Promise<PassSeal[]> {
    let rows: Row[];
    try {
      const page = await this.seals()
        .where(eq("pass", pass))
        .orderBy(desc("at"))
        .limit(PAGE_SIZE)
        .fetch();
      rows = this.believed<Row>(page.entities);
    } catch (error) {
      throw new StoreError(error);
    }
    const seals: PassSeal[] = [];
    for (const row of firstPerSeal(rows)) {
      const ms = Number(row.at.value);
      if (row.pass.value !== pass || !isSealHash(row.hash.value) || !Number.isSafeInteger(ms)) {
        continue;
      }
      seals.push({ hash: row.hash.value, at: new Date(ms).toISOString() });
    }
    return newestFirst(seals);
  }

  async byEvent(event: string): Promise<EventSeal[]> {
    // A page holds at most PAGE_SIZE rows, so read page after page, oldest first, to the limit.
    const rows: Row[] = [];
    try {
      for (let offset = 0; offset < EVENT_LIST_LIMIT; ) {
        const page = await this.seals()
          .where(eq("event", event))
          .orderBy(asc("at"))
          .limit(PAGE_SIZE)
          .offset(offset)
          .fetch();
        for (const row of this.believed<Row>(page.entities)) {
          if (row.event?.value === event) rows.push(row);
        }
        const covered = page.entities.length + page.skipped;
        if (covered < PAGE_SIZE) break;
        offset += covered;
      }
    } catch (error) {
      throw new StoreError(error);
    }
    // One seal may have several rows; the first created is the one kept, as in get().
    const seals: EventSeal[] = [];
    for (const row of firstPerSeal(rows)) {
      const ms = Number(row.at.value);
      if (!isSealHash(row.hash.value) || !Number.isSafeInteger(ms)) continue;
      seals.push({ hash: row.hash.value, pass: row.pass.value, at: new Date(ms).toISOString() });
    }
    return oldestFirst(seals);
  }

  put(record: SealRecord): Promise<SealRecord> {
    // Two requests for one seal on this server wait for each other rather than both writing.
    const waiting = this.pending.get(record.hash);
    if (waiting) return waiting;
    const work = this.write(record).finally(() => this.pending.delete(record.hash));
    this.pending.set(record.hash, work);
    return work;
  }

  private async write(record: SealRecord): Promise<SealRecord> {
    const values = {
      hash: record.hash,
      pass: record.pass,
      account: record.account ?? "",
      credential: record.credential,
      at: u64(Date.parse(record.at)),
      ...(keptName(record.name) ? { name: record.name as string } : {}),
      ...(isEvent(record.event) ? { event: record.event } : {}),
    };
    const kept = await this.get(record.hash);
    if (kept) return kept;
    if (!this.settings.privateKey) throw new StoreError();
    const writer = createWalletClient({
      chain: this.chain,
      transport: http(),
      account: privateKeyToAccount(this.settings.privateKey),
    });
    try {
      await writer.createEntity(
        Seals,
        values,
        {
          expiration: ExpirationTime.fromDays(RECORD_LIFETIME_DAYS),
          flags: { readonly: true, permissionlessExtension: false },
        },
      );
    } catch (error) {
      throw new StoreError(error);
    }
    // Read back: if another server wrote the same seal first, its record is the one kept.
    const written = await this.get(record.hash);
    if (!written) throw new StoreError();
    return written;
  }

  async getPicture(hash: string): Promise<PictureRecord | null> {
    let rows: PictureRow[];
    try {
      const page = await this.pictures()
        .where(eq("hash", hash))
        .orderBy(asc("$key"))
        .limit(PAGE_SIZE)
        .fetch();
      rows = this.believed<PictureRow>(page.entities).filter((row) => row.hash.value === hash);
    } catch (error) {
      throw new StoreError(error);
    }
    for (const row of rows.sort(byCreation)) {
      const picture = toPicture(row);
      if (picture) return picture;
    }
    return null;
  }

  async picturesByEvent(event: string): Promise<PictureRecord[]> {
    const rows: PictureRow[] = [];
    try {
      for (let offset = 0; offset < EVENT_LIST_LIMIT; ) {
        const page = await this.pictures()
          .where(eq("event", event))
          .orderBy(asc("at"))
          .limit(PAGE_SIZE)
          .offset(offset)
          .fetch();
        for (const row of this.believed<PictureRow>(page.entities)) {
          if (row.event?.value === event) rows.push(row);
        }
        const covered = page.entities.length + page.skipped;
        if (covered < PAGE_SIZE) break;
        offset += covered;
      }
    } catch (error) {
      throw new StoreError(error);
    }
    // One seal may have several rows; the first created is the one kept, as in getPicture().
    const pictures: PictureRecord[] = [];
    for (const row of firstPerSeal(rows)) {
      const picture = toPicture(row);
      if (picture) pictures.push(picture);
    }
    return pictures.slice(0, EVENT_LIST_LIMIT);
  }

  putPicture(picture: PictureRecord): Promise<PictureRecord> {
    const waiting = this.pendingPictures.get(picture.hash);
    if (waiting) return waiting;
    const done = () => this.pendingPictures.delete(picture.hash);
    const work = this.writePicture(picture).finally(done);
    this.pendingPictures.set(picture.hash, work);
    return work;
  }

  private async writePicture(picture: PictureRecord): Promise<PictureRecord> {
    const fresh = keptPicture(picture, picture.hash);
    if (!fresh) throw new Error("not a picture");
    const values = {
      hash: fresh.hash,
      at: u64(Date.parse(fresh.at)),
      ref: fresh.ref,
      sha256: fresh.sha256,
      size: u64(fresh.bytes),
      ...(fresh.event !== null ? { event: fresh.event } : {}),
    };
    const kept = await this.getPicture(fresh.hash);
    if (kept) return kept;
    if (!this.settings.privateKey) throw new StoreError();
    const writer = createWalletClient({
      chain: this.chain,
      transport: http(),
      account: privateKeyToAccount(this.settings.privateKey),
    });
    try {
      await writer.createEntity(
        Pictures,
        values,
        {
          expiration: ExpirationTime.fromDays(RECORD_LIFETIME_DAYS),
          flags: { readonly: true, permissionlessExtension: false },
        },
      );
    } catch (error) {
      throw new StoreError(error);
    }
    // Read back: if another server kept a picture for this seal first, its pointer is the one kept.
    const written = await this.getPicture(fresh.hash);
    if (!written) throw new StoreError();
    return written;
  }
}
