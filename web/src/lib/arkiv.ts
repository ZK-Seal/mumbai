import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
  type TxParams,
} from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc, desc, eq } from "@arkiv-network/sdk/query";
import { defineSchema, MAX_STRING_BYTES, str, u64 } from "@arkiv-network/sdk/schema";
import {
  custom,
  getAddress,
  http,
  isAddress,
  MethodNotFoundRpcError,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getGasPrice } from "viem/actions";
import {
  EVENT_LIST_LIMIT,
  isAccount,
  isEvent,
  keptName,
  keptImageName,
  keptPicture,
  keptUser,
  newestFirst,
  oldestFirst,
  StoreError,
  type EventSeal,
  type NameRecord,
  type PassSeal,
  type PictureRecord,
  type RecordStore,
  type SealRecord,
  type UserRecord,
} from "@/lib/records";
import { isSealHash } from "@/lib/world";

/**
 * One authorised seal on Arkiv. Only what a reader looks up by is indexed: the seal, the person's
 * pass and the event; and the time, which pages of them are sorted by. The account, the kind of
 * check and the name at a desk are only read back, so they are stored without an index. The name
 * and the event are left out when there is none.
 */
export const Seals = defineSchema("blank-demo.seals", {
  hash: str().indexed(),
  pass: str().indexed(),
  event: str().indexed().optional(),
  at: u64().indexed(),
  account: str(),
  credential: str(),
  name: str().optional(),
});

/**
 * The pointer to one seal's picture on Arkiv, an entity of its own because a seal's record is
 * read-only. Looked up by the seal and by the event, and sorted by time, so those are indexed;
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

/**
 * One person's name on Arkiv. Looked up by the label and by the pass, and sorted by time, so those
 * are indexed; the full name and the person's address are only read back. The address is left out
 * of rows written before it was kept.
 */
export const Users = defineSchema("blank-demo.users", {
  label: str().indexed(),
  pass: str().indexed(),
  at: u64().indexed(),
  name: str(),
  address: str().optional(),
});

/**
 * The name one seal's photo was given on chain. Looked up by the seal and by the event, and
 * sorted by time, so those are indexed; the name and its transaction are only read back.
 */
export const Names = defineSchema("blank-demo.names", {
  hash: str().indexed(),
  event: str().indexed(),
  at: u64().indexed(),
  name: str(),
  tx: str(),
});

/** The most user rows read when deciding who holds a name. */
const USER_LIST_LIMIT = 1000;

// A record outlives the event by weeks, but is not kept forever.
export const RECORD_LIFETIME_DAYS = 30;

/** Every entity is created read-only, so no one can change it later, and for a fixed time. */
const CREATE_OPTIONS = {
  expiration: ExpirationTime.fromDays(RECORD_LIFETIME_DAYS),
  flags: { readonly: true, permissionlessExtension: false },
};

/** The most rows the node returns in one page. */
const PAGE_SIZE = 100;

/** The least gas a single create is sent with on Rabdi, whose estimates can fall short. */
const GAS_FLOOR = BigInt(1_000_000);

/** How often, and how far apart, a write is looked for before it is reported or tried again. */
const READ_BACK_TRIES = 5;
const READ_BACK_PAUSE_MS = 1000;

export type ArkivSettings = {
  /** The wallet that writes every record. Only records it created, read-only, are believed. */
  creator: Address;
  /** The writing wallet's key; absent on a server that only reads. */
  privateKey: Hex | null;
  /** The RPC access key. Empty means the public endpoint, which is heavily rate limited. */
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
  // The one place the RPC is chosen: with a key the keyed endpoint, without one the public one.
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

let announced = false;

/** Says once, in the server log, which RPC the records go through. The key itself is not shown. */
function announce(settings: ArkivSettings): void {
  if (announced) return;
  announced = true;
  const rpc = settings.accessKey
    ? "the keyed RPC (ARKIV_ACCESS_KEY is set)"
    : "the public RPC without an access key, which is heavily rate limited";
  const mode = settings.privateKey ? "writing" : "reading only";
  console.info(`Arkiv: records on Rabdi through ${rpc}, ${mode}, as ${settings.creator}`);
}

/** Whether a value can be written as a string attribute: valid UTF-8 of at most 128 bytes. */
function fitsStr(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) return false;
  try {
    str(value);
    return true;
  } catch {
    return false;
  }
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

type UserRow = Provenance & {
  label: { value: string };
  pass: { value: string };
  at: { value: bigint };
  name: { value: string };
  address?: { value: string };
};

const USER_COLUMNS = {
  ...PROVENANCE,
  label: true,
  pass: true,
  at: true,
  name: true,
  address: true,
} as const;

function toUser(row: UserRow): UserRecord | null {
  const ms = Number(row.at.value);
  if (!Number.isSafeInteger(ms)) return null;
  return keptUser({
    label: row.label.value,
    pass: row.pass.value,
    name: row.name.value,
    address: row.address?.value ?? null,
    at: new Date(ms).toISOString(),
  });
}

/**
 * The users that hold, in order of creation: a row holds unless an earlier one already holds its
 * label or its pass. So the first write wins per label and per pass, as in the file store.
 */
function holdingUsers(rows: UserRow[]): UserRecord[] {
  const labels = new Set<string>();
  const passes = new Set<string>();
  const users: UserRecord[] = [];
  for (const row of [...rows].sort(byCreation)) {
    const user = toUser(row);
    if (!user || labels.has(user.label) || passes.has(user.pass)) continue;
    labels.add(user.label);
    passes.add(user.pass);
    users.push(user);
  }
  return users;
}

type NameRow = Provenance & {
  hash: { value: string };
  event: { value: string };
  at: { value: bigint };
  name: { value: string };
  tx: { value: string };
};

const NAME_COLUMNS = {
  ...PROVENANCE,
  hash: true,
  event: true,
  at: true,
  name: true,
  tx: true,
} as const;

function toImageName(row: NameRow): NameRecord | null {
  const ms = Number(row.at.value);
  if (!Number.isSafeInteger(ms)) return null;
  return keptImageName(
    {
      hash: row.hash.value,
      event: row.event.value,
      name: row.name.value,
      tx: row.tx.value,
      at: new Date(ms).toISOString(),
    },
    row.hash.value,
  );
}

/** One page of rows as the node answers it. */
type Page = { entities: readonly unknown[]; skipped: number };

/** The first row per seal, in order of creation. */
function firstPerSeal<T extends Provenance & { hash: { value: string } }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return [...rows].sort(byCreation).filter((row) => {
    if (seen.has(row.hash.value)) return false;
    seen.add(row.hash.value);
    return true;
  });
}

/** A write that was refused before anything was sent, so nothing can have landed. */
class NotSent extends Error {
  constructor(cause?: unknown) {
    super("not sent", { cause });
  }
}

/** The estimate the guarded wallet stops at, so that nothing is ever signed or sent by it. */
class Estimated extends Error {
  constructor(readonly gas: bigint) {
    super("estimated");
  }
}

/** The errors an error was caused by, nearest first. */
function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let at = error; at && chain.length < 24; at = (at as { cause?: unknown }).cause) {
    chain.push(at);
    if (typeof at !== "object") break;
  }
  return chain;
}

/**
 * Whether the node turned the transaction away for its nonce: another transaction from this
 * wallet took the nonce first, so this one was never admitted and may be sent again. Only an
 * error with no transaction hash counts; one with a hash may have landed.
 */
export function isNonceRefusal(error: unknown): boolean {
  const chain = causes(error);
  if (chain.some((e) => typeof (e as { txHash?: unknown })?.txHash === "string")) return false;
  return chain.some((e) => {
    const { name, message } = (e ?? {}) as { name?: unknown; message?: unknown };
    if (name === "NonceTooLowError") return true;
    return (
      typeof message === "string" &&
      /nonce too low|nonce has already been used|replacement transaction underpriced/i.test(message)
    );
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The writes of each wallet in this process, one after another: two writes sent at once would be
 * given the same nonce. This holds only within one process. Several server instances (on Vercel,
 * say) sharing the wallet can still race: the latest/pending nonce check before each send narrows
 * that, and a send the node turns away for its nonce is read back and then tried once more. Two
 * servers writing the same seal at once may both land a row; every read keeps the first created.
 */
const queues = new Map<string, Promise<unknown>>();

export function queued<T>(wallet: string, work: () => Promise<T>): Promise<T> {
  const before = queues.get(wallet) ?? Promise.resolve();
  const run = before.then(work, work);
  const after = run.then(
    () => {},
    () => {},
  );
  queues.set(wallet, after);
  void after.then(() => {
    if (queues.get(wallet) === after) queues.delete(wallet);
  });
  return run;
}

/** The methods the estimating wallet may call: reads only, and the estimate it stops at. */
const ESTIMATE_READS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getTransactionCount",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_estimateGas",
]);

/** One create, run either by the estimating wallet or by the writing one. */
type Create = (wallet: Writer, txParams?: TxParams) => Promise<unknown>;

type Writer = ReturnType<typeof createWalletClient>;

/**
 * Keeps each record as an entity on Arkiv's testnet, created read-only by the server's wallet.
 * Anyone may write an entity that looks like ours, and may hand it to our wallet, so every read
 * asks only for entities our wallet created, and believes only those created read-only: no one,
 * the creator included, can change such an entity after the fact.
 */
export class ArkivStore implements RecordStore {
  private readonly chain;
  private readonly reader;
  private readonly writer: Writer | null;
  private readonly pending = new Map<string, Promise<SealRecord>>();
  private readonly pendingPictures = new Map<string, Promise<PictureRecord>>();
  private readonly pendingUsers = new Map<string, Promise<UserRecord>>();
  private readonly pendingNames = new Map<string, Promise<NameRecord>>();

  constructor(private readonly settings: ArkivSettings) {
    announce(settings);
    this.chain = rabdi({ accessKey: settings.accessKey });
    this.reader = createPublicClient({ chain: this.chain, transport: http(), cacheTime: 0 });
    this.writer = settings.privateKey
      ? createWalletClient({
          chain: this.chain,
          transport: http(),
          account: privateKeyToAccount(settings.privateKey),
        })
      : null;
  }

  private seals() {
    return this.reader.select(SEAL_COLUMNS).from(Seals).createdBy(this.settings.creator);
  }

  private pictures() {
    return this.reader.select(PICTURE_COLUMNS).from(Pictures).createdBy(this.settings.creator);
  }

  private users() {
    return this.reader.select(USER_COLUMNS).from(Users).createdBy(this.settings.creator);
  }

  private names() {
    return this.reader.select(NAME_COLUMNS).from(Names).createdBy(this.settings.creator);
  }

  private believed<T extends Provenance>(rows: readonly unknown[]): T[] {
    return (rows as T[]).filter((row) => trusted(row, this.settings.creator));
  }

  /**
   * Reads page after page from `offset` 0, PAGE_SIZE at a time, up to `limit` rows, and keeps the
   * believed rows that `keep` accepts. A StoreError if any page cannot be read.
   */
  private async pages<T extends Provenance>(
    page: (offset: number) => Promise<Page>,
    keep: (row: T) => boolean,
    limit: number = EVENT_LIST_LIMIT,
  ): Promise<T[]> {
    const rows: T[] = [];
    try {
      for (let offset = 0; offset < limit; ) {
        const answer = await page(offset);
        rows.push(...this.believed<T>(answer.entities).filter(keep));
        const covered = answer.entities.length + answer.skipped;
        if (covered < PAGE_SIZE) break;
        offset += covered;
      }
    } catch (error) {
      throw new StoreError(error);
    }
    return rows;
  }

  /** Two writes of one thing on this server wait for each other rather than both writing. */
  private once<T>(pending: Map<string, Promise<T>>, key: string, work: () => Promise<T>) {
    const waiting = pending.get(key);
    if (waiting) return waiting;
    const run = work().finally(() => pending.delete(key));
    pending.set(key, run);
    return run;
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
    const rows = await this.pages<Row>(
      (offset) =>
        this.seals()
          .where(eq("event", event))
          .orderBy(asc("at"))
          .limit(PAGE_SIZE)
          .offset(offset)
          .fetch(),
      (row) => row.event?.value === event,
    );
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
    return this.once(this.pending, record.hash, () => this.write(record));
  }

  private async write(record: SealRecord): Promise<SealRecord> {
    const ms = Date.parse(record.at);
    const account = record.account ?? "";
    const name = keptName(record.name);
    const values = {
      hash: record.hash,
      pass: record.pass,
      account,
      credential: record.credential,
      at: u64(ms),
      ...(name ? { name } : {}),
      ...(isEvent(record.event) ? { event: record.event } : {}),
    };
    // Refused rather than cut short: a hash or a pass that does not fit is not one at all.
    const strings = [values.hash, values.pass, values.account, values.credential, name ?? ""];
    if (
      !isSealHash(record.hash) ||
      !Number.isSafeInteger(ms) ||
      ms < 0 ||
      (account !== "" && !isAccount(account)) ||
      !strings.every(fitsStr)
    ) {
      throw new Error("not a record");
    }
    return this.keep(
      () => this.get(record.hash),
      (wallet, txParams) => wallet.createEntity(Seals, values, CREATE_OPTIONS, txParams),
    );
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
    const rows = await this.pages<PictureRow>(
      (offset) =>
        this.pictures()
          .where(eq("event", event))
          .orderBy(asc("at"))
          .limit(PAGE_SIZE)
          .offset(offset)
          .fetch(),
      (row) => row.event?.value === event,
    );
    // One seal may have several rows; the first created is the one kept, as in getPicture().
    const pictures: PictureRecord[] = [];
    for (const row of firstPerSeal(rows)) {
      const picture = toPicture(row);
      if (picture) pictures.push(picture);
    }
    return pictures.slice(0, EVENT_LIST_LIMIT);
  }

  putPicture(picture: PictureRecord): Promise<PictureRecord> {
    return this.once(this.pendingPictures, picture.hash, () => this.writePicture(picture));
  }

  private async writePicture(picture: PictureRecord): Promise<PictureRecord> {
    const fresh = keptPicture(picture, picture.hash);
    const ms = fresh ? Date.parse(fresh.at) : NaN;
    if (!fresh || !Number.isSafeInteger(ms) || ms < 0) throw new Error("not a picture");
    if (![fresh.hash, fresh.ref, fresh.sha256, fresh.event ?? ""].every(fitsStr)) {
      throw new Error("not a picture");
    }
    const values = {
      hash: fresh.hash,
      at: u64(ms),
      ref: fresh.ref,
      sha256: fresh.sha256,
      size: u64(fresh.bytes),
      ...(fresh.event !== null ? { event: fresh.event } : {}),
    };
    return this.keep(
      () => this.getPicture(fresh.hash),
      (wallet, txParams) => wallet.createEntity(Pictures, values, CREATE_OPTIONS, txParams),
    );
  }

  /** Every user that holds a name, read in full: there are few, and each depends on the others. */
  private async holding(): Promise<UserRecord[]> {
    const rows = await this.pages<UserRow>(
      (offset) => this.users().orderBy(asc("at")).limit(PAGE_SIZE).offset(offset).fetch(),
      () => true,
      USER_LIST_LIMIT,
    );
    return holdingUsers(rows);
  }

  async userByLabel(label: string): Promise<UserRecord | null> {
    return (await this.holding()).find((user) => user.label === label) ?? null;
  }

  async userByPass(pass: string): Promise<UserRecord | null> {
    return (await this.holding()).find((user) => user.pass === pass) ?? null;
  }

  putUser(user: UserRecord): Promise<UserRecord> {
    return this.once(this.pendingUsers, user.label, () => this.writeUser(user));
  }

  private async writeUser(user: UserRecord): Promise<UserRecord> {
    const fresh = keptUser(user);
    const ms = fresh ? Date.parse(fresh.at) : NaN;
    if (!fresh || !Number.isSafeInteger(ms) || ms < 0) throw new Error("not a user");
    if (![fresh.label, fresh.pass, fresh.name, fresh.address ?? ""].every(fitsStr)) {
      throw new Error("not a user");
    }
    const values = {
      label: fresh.label,
      pass: fresh.pass,
      at: u64(ms),
      name: fresh.name,
      ...(fresh.address ? { address: fresh.address } : {}),
    };
    // Whatever holds the label, or else the pass, is what is kept: ours once it has landed.
    const find = async () => {
      const users = await this.holding();
      return (
        users.find((u) => u.label === fresh.label) ??
        users.find((u) => u.pass === fresh.pass) ??
        null
      );
    };
    return this.keep(find, (wallet, txParams) =>
      wallet.createEntity(Users, values, CREATE_OPTIONS, txParams),
    );
  }

  async getName(hash: string): Promise<NameRecord | null> {
    const rows = await this.pages<NameRow>(
      (offset) =>
        this.names()
          .where(eq("hash", hash))
          .orderBy(asc("$key"))
          .limit(PAGE_SIZE)
          .offset(offset)
          .fetch(),
      (row) => row.hash.value === hash,
      PAGE_SIZE,
    );
    for (const row of rows.sort(byCreation)) {
      const name = toImageName(row);
      if (name) return name;
    }
    return null;
  }

  async namesByEvent(event: string): Promise<NameRecord[]> {
    const rows = await this.pages<NameRow>(
      (offset) =>
        this.names()
          .where(eq("event", event))
          .orderBy(asc("at"))
          .limit(PAGE_SIZE)
          .offset(offset)
          .fetch(),
      (row) => row.event.value === event,
    );
    // One seal may have several rows; the first created is the one kept, as in getName().
    const names: NameRecord[] = [];
    for (const row of firstPerSeal(rows)) {
      const name = toImageName(row);
      if (name) names.push(name);
    }
    return names.slice(0, EVENT_LIST_LIMIT);
  }

  putName(name: NameRecord): Promise<NameRecord> {
    return this.once(this.pendingNames, name.hash, () => this.writeName(name));
  }

  private async writeName(name: NameRecord): Promise<NameRecord> {
    const fresh = keptImageName(name, name.hash);
    const ms = fresh ? Date.parse(fresh.at) : NaN;
    if (!fresh || !Number.isSafeInteger(ms) || ms < 0) throw new Error("not a name");
    if (![fresh.hash, fresh.event, fresh.name, fresh.tx].every(fitsStr)) {
      throw new Error("not a name");
    }
    const values = {
      hash: fresh.hash,
      event: fresh.event,
      at: u64(ms),
      name: fresh.name,
      tx: fresh.tx,
    };
    return this.keep(
      () => this.getName(fresh.hash),
      (wallet, txParams) => wallet.createEntity(Names, values, CREATE_OPTIONS, txParams),
    );
  }

  /**
   * Writes once unless something is kept already, and returns what is kept. After a write, or a
   * failure that may have been one (a timeout, a lost answer), the write is looked for before
   * anything is reported, and it is never sent again unless the node turned it away for its
   * nonce: so a second row for the same seal is not written while the first is still on its way.
   * If several are written all the same, by several servers at once, every read keeps the first.
   */
  private async keep<T>(find: () => Promise<T | null>, create: Create): Promise<T> {
    const kept = await find();
    if (kept) return kept;
    if (!this.writer) throw new StoreError();
    for (let attempt = 1; ; attempt++) {
      let failure: unknown = null;
      try {
        await queued(this.settings.creator, () => this.send(create));
      } catch (error) {
        if (error instanceof NotSent) throw new StoreError(error.cause);
        failure = error;
      }
      const found = await this.readBack(find);
      if (found) return found;
      if (attempt > 1 || failure === null || !isNonceRefusal(failure)) {
        throw new StoreError(failure);
      }
    }
  }

  /** Looks for a write up to READ_BACK_TRIES times, READ_BACK_PAUSE_MS apart. */
  private async readBack<T>(find: () => Promise<T | null>): Promise<T | null> {
    for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
      if (attempt > 0) await sleep(READ_BACK_PAUSE_MS);
      try {
        const found = await find();
        if (found) return found;
      } catch {
        // Not readable yet; look again.
      }
    }
    return null;
  }

  /**
   * Sends one create with every field set: gas of at least max(1,000,000, twice the estimate)
   * and at most half a block, the latest nonce once nothing of ours is pending, and the network's
   * gas price. Anything refused before the send throws NotSent.
   */
  private async send(create: Create): Promise<void> {
    const writer = this.writer;
    if (!writer) throw new NotSent();
    let txParams: TxParams;
    try {
      const estimate = await this.estimate(create);
      const twice = BigInt(2) * estimate;
      const gas = twice > GAS_FLOOR ? twice : GAS_FLOOR;
      const block = await this.reader.getBlock({ blockTag: "latest" });
      if (gas > block.gasLimit / BigInt(2)) throw new Error("gas above half a block");
      const address = this.settings.creator;
      let nonce = -1;
      for (let attempt = 0; attempt < READ_BACK_TRIES; attempt++) {
        if (attempt > 0) await sleep(READ_BACK_PAUSE_MS);
        const latest = await this.reader.getTransactionCount({ address, blockTag: "latest" });
        const waiting = await this.reader.getTransactionCount({ address, blockTag: "pending" });
        if (latest === waiting) {
          nonce = latest;
          break;
        }
      }
      if (nonce < 0) throw new Error("another write from this wallet is pending");
      const gasPrice = await getGasPrice(this.reader);
      if (gas * gasPrice > (await this.reader.getBalance({ address }))) {
        throw new Error("not enough funds for the gas");
      }
      txParams = { nonce, gas, gasPrice };
    } catch (error) {
      throw error instanceof NotSent ? error : new NotSent(error);
    }
    await create(writer, txParams);
  }

  /**
   * The node's gas estimate for exactly this create, through a wallet that holds no key and may
   * only read: it stops at the estimate, so nothing is signed or sent.
   */
  async estimate(create: Create): Promise<bigint> {
    const rpc = http(undefined, { retryCount: 0 })({ chain: this.chain });
    const transport = custom(
      {
        async request(args: { method: string; params?: unknown }) {
          // Without this, viem may ask the node to fill the whole transaction instead.
          if (args.method === "eth_fillTransaction") throw new MethodNotFoundRpcError(new Error());
          if (!ESTIMATE_READS.has(args.method)) throw new NotSent();
          const result = await rpc.request(args as Parameters<typeof rpc.request>[0]);
          if (args.method !== "eth_estimateGas") return result;
          if (typeof result !== "string" || !/^0x[0-9a-f]+$/i.test(result)) throw new NotSent();
          throw new Estimated(BigInt(result));
        },
      },
      { retryCount: 0 },
    );
    const wallet = createWalletClient({
      chain: this.chain,
      transport,
      account: this.settings.creator,
    }) as unknown as Writer;
    try {
      await create(wallet);
    } catch (error) {
      const found = causes(error).find((e) => e instanceof Estimated) as Estimated | undefined;
      if (found && found.gas > BigInt(0)) return found.gas;
      throw new NotSent(error);
    }
    throw new NotSent();
  }
}
