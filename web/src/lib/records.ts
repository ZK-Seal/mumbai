import { randomBytes } from "node:crypto";
import { mkdir, readFile, link, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
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
  get(hash: string): Promise<SealRecord | null>;
  /** Keeps the record unless the hash already has one. Returns whichever record is kept. */
  put(record: SealRecord): Promise<SealRecord>;
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
  const account =
    typeof value.account === "string" && /^[0-9a-f]{16}$/.test(value.account)
      ? value.account
      : null;
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
      throw error;
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const other = await this.get(record.hash);
      if (!other) throw error;
      return other;
    } finally {
      await unlink(temp).catch(() => {});
    }
    return { hash, pass, credential, account, at };
  }
}

let store: RecordStore | null = null;

/** The store this server uses, kept under DATA_DIR (default `.data`). */
export function records(): RecordStore {
  store ??= new FileStore(path.resolve(process.env.DATA_DIR || ".data", "seals"));
  return store;
}
