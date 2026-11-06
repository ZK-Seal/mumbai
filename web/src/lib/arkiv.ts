import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
  type TxParams,
} from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc, desc, eq } from "@arkiv-network/sdk/query";
import { defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
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

  constructor(private readonly settings: ArkivSettings) {
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
    return this.keep(
      () => this.get(record.hash),
      (wallet, txParams) =>
        wallet.createEntity(
          Seals,
          values,
          {
            expiration: ExpirationTime.fromDays(RECORD_LIFETIME_DAYS),
            flags: { readonly: true, permissionlessExtension: false },
          },
          txParams,
        ),
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
    return this.keep(
      () => this.getPicture(fresh.hash),
      (wallet, txParams) =>
        wallet.createEntity(
          Pictures,
          values,
          {
            expiration: ExpirationTime.fromDays(RECORD_LIFETIME_DAYS),
            flags: { readonly: true, permissionlessExtension: false },
          },
          txParams,
        ),
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
