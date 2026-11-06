import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, link, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArkivStore, arkivSettings } from "@/lib/arkiv";
import { normalName } from "@/lib/ens";
import type { Credential } from "@/lib/world";
import { isSwarmRef } from "@/lib/swarm";
import { isSealHash } from "@/lib/world";

/**
 * One authorised seal. `pass` is the person's pass number; one person may authorise many seals.
 * `account` is no longer filled in and is kept as null; older records may still carry one.
 * `name` is the person's name at a desk, kept only when the desk vouched for it at the time.
 * `event` is the event the photo was sealed at, when the link named one.
 */
export type SealRecord = {
  hash: string;
  pass: string;
  credential: Credential;
  account: string | null;
  name: string | null;
  event: string | null;
  at: string;
};

export interface RecordStore {
  /** The record kept for this seal, or null if it has none. Throws a StoreError if unsure. */
  get(hash: string): Promise<SealRecord | null>;
  /** Keeps the record unless the hash already has one. Returns whichever record is kept. */
  put(record: SealRecord): Promise<SealRecord>;
  /** The newest seals authorised with this pass, at most PASS_LIST_LIMIT of them. */
  byPass(pass: string): Promise<PassSeal[]>;
  /** The seals authorised at this event, oldest first, at most EVENT_LIST_LIMIT of them. */
  byEvent(event: string): Promise<EventSeal[]>;
  /** The picture kept for this seal, or null if it has none. Throws a StoreError if unsure. */
  getPicture(hash: string): Promise<PictureRecord | null>;
  /** Keeps the pointer unless the seal already has a picture. Returns whichever pointer is kept. */
  putPicture(picture: PictureRecord): Promise<PictureRecord>;
  /** The pictures of seals authorised at this event, at most EVENT_LIST_LIMIT of them. */
  picturesByEvent(event: string): Promise<PictureRecord[]>;
}

/**
 * A pointer to the picture of one seal, kept apart from the seal's record because a record is
 * never changed once written. The file itself is on Swarm under `ref`; `sha256` and `bytes` are
 * those of the file as it was uploaded, so a picture fetched later can be checked against them.
 * `event` is the event of the seal's record, so an event's pictures can be found in one look.
 */
export type PictureRecord = {
  hash: string;
  event: string | null;
  ref: string;
  sha256: string;
  bytes: number;
  at: string;
};

/** The largest picture kept, in bytes: below the request size a hosted server accepts. */
export const PICTURE_MAX_BYTES = 3 * 1024 * 1024;

/** The smallest picture kept, in bytes. */
export const PICTURE_MIN_BYTES = 1024;

/** A pointer as it may be kept: every field well formed, or it is not a pointer. */
export function keptPicture(value: unknown, hash: string): PictureRecord | null {
  const v = value as Partial<PictureRecord> | null;
  if (v?.hash !== hash || !isSealHash(hash)) return null;
  if (!isSwarmRef(v.ref) || typeof v.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(v.sha256)) {
    return null;
  }
  if (typeof v.bytes !== "number" || !Number.isSafeInteger(v.bytes) || v.bytes < 1) return null;
  if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
  const event = isEvent(v.event) ? v.event : null;
  return { hash, event, ref: v.ref, sha256: v.sha256, bytes: v.bytes, at: v.at };
}

/** One seal in the list of seals a pass authorised. The edit is not kept, so it is not here. */
export type PassSeal = { hash: string; at: string };

export const PASS_LIST_LIMIT = 10;

/** One seal authorised at an event, with the pass that authorised it. */
export type EventSeal = { hash: string; pass: string; at: string };

export const EVENT_LIST_LIMIT = 500;

/** An event is named by a short slug: lowercase letters, digits and dashes. */
export function isEvent(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{2,39}$/.test(value);
}

/** Oldest first, then by hash so the order never wobbles; at most EVENT_LIST_LIMIT. */
export function oldestFirst(seals: EventSeal[]): EventSeal[] {
  return seals
    .sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.hash < b.hash ? -1 : 1))
    .slice(0, EVENT_LIST_LIMIT);
}

/** The seals of one person at an event. The pass is left out, as the pass list leaves it out. */
export type EventGroup = { photos: PassSeal[] };

/** One group per pass, in the order each pass was first seen; each group oldest first. */
export function byPerson(seals: EventSeal[]): EventGroup[] {
  const groups = new Map<string, PassSeal[]>();
  for (const { hash, pass, at } of oldestFirst(seals)) {
    const photos = groups.get(pass) ?? [];
    photos.push({ hash, at });
    groups.set(pass, photos);
  }
  return [...groups.values()].map((photos) => ({ photos }));
}

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

/** An account name, as older records keep it: 16 lowercase hex characters. */
export function isAccount(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/.test(value);
}

/** A name kept with a record: in normal form already, or it is not kept. */
export function keptName(value: unknown): string | null {
  return typeof value === "string" && normalName(value) === value ? value : null;
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
  const name = keptName(value.name);
  const event = isEvent(value.event) ? value.event : null;
  const { pass, credential, at } = value;
  return { hash, pass, credential, account, name, event, at };
}

/**
 * Writes `text` as `<hash>.json` in `dir` unless that file is there already. The text goes to a
 * temporary file that is then linked into place, which fails if the name is taken: so the first
 * write for a hash wins, and a half-written file is never seen. True if this write is the one kept.
 */
async function writeOnce(dir: string, hash: string, text: string): Promise<boolean> {
  if (!isSealHash(hash)) throw new Error("not a seal hash");
  const temp = path.join(dir, `.${hash}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, text, { flag: "wx" });
    await link(temp, path.join(dir, `${hash}.json`));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new StoreError(error);
    return false;
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/**
 * Keeps each record as its own JSON file, named by the seal's hash, and each picture pointer the
 * same way in a directory of its own. The first record, and the first pointer, for a hash wins.
 */
export class FileStore implements RecordStore {
  constructor(
    private readonly dir: string,
    private readonly pictureDir: string,
  ) {}

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
    const kept = await this.get(record.hash);
    if (kept) return kept;
    const { hash, pass, credential, account, at } = record;
    const name = keptName(record.name);
    const event = isEvent(record.event) ? record.event : null;
    const fresh = { hash, pass, credential, account, name, event, at };
    if (await writeOnce(this.dir, hash, JSON.stringify(fresh))) return fresh;
    const other = await this.get(hash);
    if (!other) throw new StoreError();
    return other;
  }

  async getPicture(hash: string): Promise<PictureRecord | null> {
    if (!isSealHash(hash)) throw new Error("not a seal hash");
    let text: string;
    try {
      text = await readFile(path.join(this.pictureDir, `${hash}.json`), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new StoreError(error);
    }
    try {
      return keptPicture(JSON.parse(text), hash);
    } catch {
      return null;
    }
  }

  async putPicture(picture: PictureRecord): Promise<PictureRecord> {
    const fresh = keptPicture(picture, picture.hash);
    if (!fresh) throw new Error("not a picture");
    const kept = await this.getPicture(fresh.hash);
    if (kept) return kept;
    if (await writeOnce(this.pictureDir, fresh.hash, JSON.stringify(fresh))) return fresh;
    const other = await this.getPicture(fresh.hash);
    if (!other) throw new StoreError();
    return other;
  }

  async picturesByEvent(event: string): Promise<PictureRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.pictureDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new StoreError(error);
    }
    const found: PictureRecord[] = [];
    for (const name of names) {
      const hash = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isSealHash(hash)) continue;
      const picture = await this.getPicture(hash);
      if (picture?.event === event) found.push(picture);
    }
    return found.slice(0, EVENT_LIST_LIMIT);
  }

  /** Every record kept in the directory. */
  private async all(): Promise<SealRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new StoreError(error);
    }
    const found: SealRecord[] = [];
    for (const name of names) {
      const hash = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!isSealHash(hash)) continue;
      const record = await this.get(hash);
      if (record) found.push(record);
    }
    return found;
  }

  async byPass(pass: string): Promise<PassSeal[]> {
    const found = (await this.all()).filter((record) => record.pass === pass);
    return newestFirst(found.map(({ hash, at }) => ({ hash, at })));
  }

  async byEvent(event: string): Promise<EventSeal[]> {
    const found = (await this.all()).filter((record) => record.event === event);
    return oldestFirst(found.map(({ hash, pass, at }) => ({ hash, pass, at })));
  }
}

let store: RecordStore | null = null;

/**
 * The store this server uses. With ARKIV_PRIVATE_KEY (or ARKIV_OWNER, to read only) the records
 * and picture pointers live on Arkiv; otherwise each is a file under DATA_DIR (default `.data`).
 */
export function records(): RecordStore {
  if (store) return store;
  const arkiv = arkivSettings();
  const data = process.env.DATA_DIR || ".data";
  store = arkiv
    ? new ArkivStore(arkiv)
    : new FileStore(path.resolve(data, "seals"), path.resolve(data, "pictures"));
  return store;
}
