import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, link, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArkivStore, arkivSettings } from "@/lib/arkiv";
import type { Credential } from "@/lib/world";
import { isSealHash } from "@/lib/world";

/**
 * One authorised seal. `pass` is the person's pass number; one person may authorise many seals.
 * `account` is a short name for the World account that was signed in, when sign-in is set up.
 */
export type SealRecord = {
  hash: string;
  pass: string;
  credential: Credential;
  account: string | null;
  at: string;
};

export interface RecordStore {
  /** The record kept for this seal, or null if it has none. Throws a StoreError if unsure. */
  get(hash: string): Promise<SealRecord | null>;
  /** Keeps the record unless the hash already has one. Returns whichever record is kept. */
  put(record: SealRecord): Promise<SealRecord>;
  /** The newest seals authorised with this pass, at most PASS_LIST_LIMIT of them. */
  byPass(pass: string): Promise<PassSeal[]>;
}

/** One seal in the list of seals a pass authorised. The edit is not kept, so it is not here. */
export type PassSeal = { hash: string; at: string };

export const PASS_LIST_LIMIT = 10;

/** A pass is a number, in decimal or 0x hex, short enough to be kept. */
export function isPass(value: unknown): value is string {
  return typeof value === "string" && /^(0x[0-9a-f]{1,124}|[0-9]{1,126})$/i.test(value);
}

/** Newest first, then by hash so the order never wobbles; at most PASS_LIST_LIMIT. */
export function newestFirst(seals: PassSeal[]): PassSeal[] {
  return seals
    .sort((a, b) => (a.at !== b.at ? (a.at < b.at ? 1 : -1) : a.hash < b.hash ? -1 : 1))
    .slice(0, PASS_LIST_LIMIT);
}

/** The store could not be read or written, so nothing can be said about the seal. */
export class StoreError extends Error {
  readonly word = "store";
  constructor(cause?: unknown) {
    super("store", { cause });
  }
}

/** An account name, as the sign-in keeps it: 16 lowercase hex characters. */
export function isAccount(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

function readRecord(text: string, hash: string): SealRecord | null {
  let value: Partial<SealRecord>;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value?.hash !== hash || typeof value.pass !== "string" || typeof value.at !== "string") {
    return null;
  }
  if (value.credential !== "human" && value.credential !== "selfie") return null;
  const account = isAccount(value.account) ? value.account : null;
  return { hash, pass: value.pass, credential: value.credential, account, at: value.at };
}

/**
 * Keeps each record as its own JSON file, named by the seal's hash. A record is written to a
 * temporary file and then linked into place, which fails if the name is taken: so the first
 * record for a hash wins, and a half-written file is never seen.
 */
export class FileStore implements RecordStore {
  constructor(private readonly dir: string) {}

  private file(hash: string): string {
    if (!isSealHash(hash)) throw new Error("not a seal hash");
    return path.join(this.dir, `${hash}.json`);
  }

  async get(hash: string): Promise<SealRecord | null> {
    let text: string;
    try {
      text = await readFile(this.file(hash), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new StoreError(error);
    }
    return readRecord(text, hash);
  }

  async put(record: SealRecord): Promise<SealRecord> {
    const final = this.file(record.hash);
    const kept = await this.get(record.hash);
    if (kept) return kept;
    await mkdir(this.dir, { recursive: true });
    const temp = path.join(this.dir, `.${record.hash}.${randomBytes(6).toString("hex")}.tmp`);
    const { hash, pass, credential, account, at } = record;
    await writeFile(temp, JSON.stringify({ hash, pass, credential, account, at }), { flag: "wx" });
    try {
      await link(temp, final);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new StoreError(error);
      const other = await this.get(record.hash);
      if (!other) throw new StoreError(error);
      return other;
    } finally {
      await unlink(temp).catch(() => {});
    }
    return { hash, pass, credential, account, at };
  }

  async byPass(pass: string): Promise<PassSeal[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new StoreError(error);
    }
    const found: PassSeal[] = [];
    for (const name of names) {
      const hash = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isSealHash(hash)) continue;
      const record = await this.get(hash);
      if (record?.pass === pass) found.push({ hash, at: record.at });
    }
    return newestFirst(found);
  }
}

let store: RecordStore | null = null;

/**
 * The store this server uses. With ARKIV_PRIVATE_KEY (or ARKIV_OWNER, to read only) the records
 * live on Arkiv; otherwise each is a file under DATA_DIR (default `.data`).
 */
export function records(): RecordStore {
  if (store) return store;
  const arkiv = arkivSettings();
  store = arkiv
    ? new ArkivStore(arkiv)
    : new FileStore(path.resolve(process.env.DATA_DIR || ".data", "seals"));
  return store;
}
