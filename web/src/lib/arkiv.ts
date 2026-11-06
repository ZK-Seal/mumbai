import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc, eq } from "@arkiv-network/sdk/query";
import { defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { getAddress, http, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isAccount, StoreError, type RecordStore, type SealRecord } from "@/lib/records";

/**
 * One authorised seal on Arkiv. Every column is indexed, because each one is something a reader
 * looks up by: the seal, the person's pass, the account, the kind of check, and the time.
 */
export const Seals = defineSchema("blank-demo.seals", {
  hash: str().indexed(),
  pass: str().indexed(),
  account: str().indexed(),
  credential: str().indexed(),
  at: u64().indexed(),
});

// A record outlives the event by weeks, but is not kept forever.
export const RECORD_LIFETIME_DAYS = 30;

export type ArkivSettings = {
  /** The wallet that writes, and so owns, every record. Only its records are believed. */
  owner: Address;
  /** The writing wallet's key; absent on a server that only reads. */
  privateKey: Hex | null;
  accessKey: string;
};

/**
 * Reads the Arkiv settings from the environment. Null when neither ARKIV_PRIVATE_KEY nor
 * ARKIV_OWNER is set. Throws a StoreError when one is set but is not well formed, so a typo never
 * quietly falls back to another store.
 */
export function arkivSettings(): ArkivSettings | null {
  const key = process.env.ARKIV_PRIVATE_KEY ?? "";
  const owner = process.env.ARKIV_OWNER ?? "";
  const accessKey = process.env.ARKIV_ACCESS_KEY ?? "";
  if (key !== "") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new StoreError();
    const privateKey = key as Hex;
    return { owner: privateKeyToAccount(privateKey).address, privateKey, accessKey };
  }
  if (owner !== "") {
    if (!isAddress(owner)) throw new StoreError();
    return { owner: getAddress(owner), privateKey: null, accessKey };
  }
  return null;
}

type Row = {
  $key: Hex;
  hash: { value: string };
  pass: { value: string };
  account: { value: string };
  credential: { value: string };
  at: { value: bigint };
};

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
    at: new Date(ms).toISOString(),
  };
}

/** The first of several rows for one seal: the earliest time, then the smallest key. */
function first(rows: readonly Row[]): SealRecord | null {
  const sorted = [...rows].sort((a, b) =>
    a.at.value !== b.at.value ? (a.at.value < b.at.value ? -1 : 1) : a.$key < b.$key ? -1 : 1,
  );
  for (const row of sorted) {
    const record = toRecord(row);
    if (record) return record;
  }
  return null;
}

/**
 * Keeps each record as an entity on Arkiv's testnet, owned by the server's wallet. Anyone may
 * write an entity that looks like ours, so every read asks only for entities this wallet owns.
 * An entity is written read-only: no one, the owner included, can change it after the fact; the
 * owner can only let it expire or delete it.
 */
export class ArkivStore implements RecordStore {
  private readonly chain;
  private readonly reader;
  private readonly pending = new Map<string, Promise<SealRecord>>();

  constructor(private readonly settings: ArkivSettings) {
    this.chain = rabdi({ accessKey: settings.accessKey });
    this.reader = createPublicClient({ chain: this.chain, transport: http() });
  }

  private async rows(hash: string): Promise<Row[]> {
    try {
      const page = await this.reader
        .select({ $key: true, hash: true, pass: true, account: true, credential: true, at: true })
        .from(Seals)
        .where(eq("hash", hash))
        .ownedBy(this.settings.owner)
        .orderBy(asc("at"))
        .limit(10)
        .fetch();
      return page.entities.filter((row) => row.hash.value === hash) as Row[];
    } catch (error) {
      throw new StoreError(error);
    }
  }

  async get(hash: string): Promise<SealRecord | null> {
    return first(await this.rows(hash));
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
        {
          hash: record.hash,
          pass: record.pass,
          account: record.account ?? "",
          credential: record.credential,
          at: u64(Date.parse(record.at)),
        },
        { expiration: ExpirationTime.fromDays(RECORD_LIFETIME_DAYS), flags: { readonly: true } },
      );
    } catch (error) {
      throw new StoreError(error);
    }
    // Read back: if another server wrote the same seal first, its record is the one kept.
    const written = await this.get(record.hash);
    if (!written) throw new StoreError();
    return written;
  }
}
