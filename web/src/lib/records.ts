import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, link, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArkivStore, arkivSettings } from "@/lib/arkiv";
import { normalName } from "@/lib/ens";
import type { Credential } from "@/lib/world";
import { isSwarmRef, pictureUrl } from "@/lib/swarm";
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
  /**
   * Keeps the user unless the label or the pass has one already: one name per person, one person
   * per name. Returns whichever user is kept for the label, or else for the pass.
   */
  putUser(user: UserRecord): Promise<UserRecord>;
  /** The user kept under this label, or null. Throws a StoreError if unsure. */
  userByLabel(label: string): Promise<UserRecord | null>;
  /** The user kept for this pass, or null. Throws a StoreError if unsure. */
  userByPass(pass: string): Promise<UserRecord | null>;
  /** The name kept for this seal's photo, or null. Throws a StoreError if unsure. */
  getName(hash: string): Promise<NameRecord | null>;
  /** Keeps the name unless the seal has one already. Returns whichever name is kept. */
  putName(name: NameRecord): Promise<NameRecord>;
  /** The names of photos at this event, at most EVENT_LIST_LIMIT of them. */
  namesByEvent(event: string): Promise<NameRecord[]>;
}

/**
 * The name a photo was given on chain, <label>.<event>.events.<root>, and the transaction that
 * created it. Kept apart from the seal's record, which is never changed once written, and only
 * once the name is there. Only a photo at an event, authorised by a person with a name, has one.
 */
export type NameRecord = { hash: string; event: string; name: string; tx: string; at: string };

/** A photo's name as it may be kept: every field well formed, or it is not one. */
export function keptImageName(value: unknown, hash: string): NameRecord | null {
  const v = value as Partial<NameRecord> | null;
  if (v?.hash !== hash || !isSealHash(hash) || !isEvent(v.event)) return null;
  const name = keptName(v.name);
  // The transaction is "" when the name was on chain already and nothing had to be sent.
  if (name === null || typeof v.tx !== "string" || !/^(0x[0-9a-f]{64})?$/.test(v.tx)) return null;
  if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
  return { hash, event: v.event, name, tx: v.tx, at: v.at };
}

/**
 * Where a photo's name stands: there, or on its way (the photo has a picture and its person a
 * name, but the name is not kept yet), or null when it will not get one.
 */
export type ImageState = { name: string; state: "done" } | { state: "pending" } | null;

export function imageState(
  kept: NameRecord | null | undefined,
  picture: PictureRecord | null | undefined,
  event: string | null,
  user: string | null,
): ImageState {
  if (kept) return { name: kept.name, state: "done" };
  return picture && event && user ? { state: "pending" } : null;
}

/**
 * A person with a name of their own: `label` is the part they chose, `name` the full name it
 * makes (<label>.users.<root>), and `pass` the pass of the World proof they gave for it. A name
 * is kept only for a person who gave a proof, and a person keeps one name.
 */
export type UserRecord = { label: string; name: string; pass: string; at: string };

/** A label someone may choose: 3 to 20 lowercase letters, digits and dashes, not one of ours. */
export function isLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9][a-z0-9-]{2,19}$/.test(value) &&
    !RESERVED_LABELS.has(value)
  );
}

/** Labels that name a branch of the tree, or would look like ours. */
export const RESERVED_LABELS = new Set(["users", "events", "www", "admin"]);

/** A user as it may be kept: every field well formed, or it is not a user. */
export function keptUser(value: unknown): UserRecord | null {
  const v = value as Partial<UserRecord> | null;
  if (!isLabel(v?.label) || !isPass(v.pass)) return null;
  const name = keptName(v.name);
  if (name === null || !name.startsWith(`${v.label}.`)) return null;
  if (typeof v.at !== "string" || Number.isNaN(Date.parse(v.at))) return null;
  return { label: v.label, name, pass: v.pass, at: v.at };
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

/** Where a seal's picture can be seen: its Swarm reference and a public address for it. */
export type PictureLink = { ref: string; url: string };

export function pictureLink(picture: PictureRecord | null | undefined): PictureLink | null {
  return picture ? { ref: picture.ref, url: pictureUrl(picture.ref) } : null;
}

/**
 * A seal of one person at an event, with its picture when one was kept, the person's user name
 * when they have one, and the photo's own name.
 */
export type EventPhoto = PassSeal & {
  picture: PictureLink | null;
  name: string | null;
  image: ImageState;
};

/** One person's photos at an event, under their user name when they have one. */
export type EventPhotos = { name: string | null; photos: EventPhoto[] };

/**
 * The groups of an event, each under its person's user name or null, each photo with its
 * picture and its own name, or null.
 */
export function withPictures(
  event: string,
  groups: EventGroup[],
  pictures: PictureRecord[],
  names: NameRecord[] = [],
): EventPhotos[] {
  const byHash = new Map(pictures.map((picture) => [picture.hash, picture]));
  const named = new Map(names.map((name) => [name.hash, name]));
  return groups.map(({ name, photos }) => ({
    name,
    photos: photos.map((photo) => {
      const picture = byHash.get(photo.hash);
      return {
        ...photo,
        picture: pictureLink(picture),
        name,
        image: imageState(named.get(photo.hash), picture, event, name),
      };
    }),
  }));
}

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

/**
 * The seals of one person at an event, with their user name or null. The pass is left out, as
 * the pass list leaves it out.
 */
export type EventGroup = { name: string | null; photos: PassSeal[] };

/**
 * One group per pass, in the order each pass was first seen; each group oldest first, under the
 * user name `names` gives for its pass.
 */
export function byPerson(seals: EventSeal[], names: Map<string, string> = new Map()): EventGroup[] {
  const groups = new Map<string, PassSeal[]>();
  for (const { hash, pass, at } of oldestFirst(seals)) {
    const photos = groups.get(pass) ?? [];
    photos.push({ hash, at });
    groups.set(pass, photos);
  }
  return [...groups].map(([pass, photos]) => ({ name: names.get(pass) ?? null, photos }));
}

/**
 * Everything an event's page shows: its seals, and its people in groups, each photo with its
 * picture and names. Throws a StoreError if any of it cannot be read.
 */
export async function eventPhotos(event: string) {
  const store = records();
  const [seals, pictures, names] = await Promise.all([
    store.byEvent(event),
    store.picturesByEvent(event),
    store.namesByEvent(event),
  ]);
  const users = await userNames(store, seals);
  return { seals, groups: withPictures(event, byPerson(seals, users), pictures, names) };
}

/** The user name of each pass among these seals that has one. */
export async function userNames(store: RecordStore, seals: EventSeal[]) {
  const passes = [...new Set(seals.map((seal) => seal.pass))];
  const users = await Promise.all(passes.map((pass) => store.userByPass(pass)));
  return new Map(users.flatMap((user) => (user ? [[user.pass, user.name] as const] : [])));
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

/** The longest name kept, in UTF-8 bytes: what one string attribute on Arkiv holds. */
export const NAME_MAX_BYTES = 128;

/**
 * A name kept with a record: in normal form already and short enough, or it is not kept. A name
 * may be up to 255 characters, so a longer one is left out of the record rather than cut short.
 */
export function keptName(value: unknown): string | null {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > NAME_MAX_BYTES) return null;
  return normalName(value) === value ? value : null;
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

/** A file name a record may be kept under: a seal hash, a label, or a hash of a pass. */
function isKey(value: string): boolean {
  return /^[0-9a-z][0-9a-z-]{0,63}$/.test(value);
}

/** The file name a pass is kept under: its SHA-256, so any pass makes a short, safe name. */
function passKey(pass: string): string {
  return createHash("sha256").update(pass).digest("hex");
}

/** Reads `<key>.json` in `dir`: null if there is none, a StoreError if it cannot be read. */
async function readKept(dir: string, key: string): Promise<string | null> {
  if (!isKey(key)) throw new Error("not a key");
  try {
    return await readFile(path.join(dir, `${key}.json`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new StoreError(error);
  }
}

function parsed(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Writes `text` as `<key>.json` in `dir` unless that file is there already. The text goes to a
 * temporary file that is then linked into place, which fails if the name is taken: so the first
 * write for a hash wins, and a half-written file is never seen. True if this write is the one kept.
 */
async function writeOnce(dir: string, key: string, text: string): Promise<boolean> {
  if (!isKey(key)) throw new Error("not a key");
  const temp = path.join(dir, `.${key}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(temp, text, { flag: "wx" });
    await link(temp, path.join(dir, `${key}.json`));
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
 * Each user is a file named by its label, with a second copy named by a hash of its pass.
 */
export class FileStore implements RecordStore {
  constructor(
    private readonly dir: string,
    private readonly pictureDir: string,
    private readonly userDir: string,
    private readonly nameDir: string,
  ) {}

  async getName(hash: string): Promise<NameRecord | null> {
    if (!isSealHash(hash)) throw new Error("not a seal hash");
    return keptImageName(parsed(await readKept(this.nameDir, hash)), hash);
  }

  async putName(name: NameRecord): Promise<NameRecord> {
    const fresh = keptImageName(name, name.hash);
    if (!fresh) throw new Error("not a name");
    const kept = await this.getName(fresh.hash);
    if (kept) return kept;
    if (await writeOnce(this.nameDir, fresh.hash, JSON.stringify(fresh))) return fresh;
    const other = await this.getName(fresh.hash);
    if (!other) throw new StoreError();
    return other;
  }

  async namesByEvent(event: string): Promise<NameRecord[]> {
    let files: string[];
    try {
      files = await readdir(this.nameDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new StoreError(error);
    }
    const found: NameRecord[] = [];
    for (const file of files) {
      const hash = file.endsWith(".json") ? file.slice(0, -5) : "";
      if (!isSealHash(hash)) continue;
      const name = await this.getName(hash);
      if (name?.event === event) found.push(name);
    }
    return found.slice(0, EVENT_LIST_LIMIT);
  }

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

  async userByLabel(label: string): Promise<UserRecord | null> {
    if (!isLabel(label)) return null;
    const user = keptUser(parsed(await readKept(path.join(this.userDir, "label"), label)));
    return user?.label === label ? user : null;
  }

  async userByPass(pass: string): Promise<UserRecord | null> {
    if (!isPass(pass)) return null;
    const user = keptUser(parsed(await readKept(path.join(this.userDir, "pass"), passKey(pass))));
    return user?.pass === pass ? user : null;
  }

  /**
   * The label is claimed first, then the pass. A label claimed by a pass that turns out to have a
   * name already is let go again, so the pass keeps the one name it had.
   */
  async putUser(user: UserRecord): Promise<UserRecord> {
    const fresh = keptUser(user);
    if (!fresh) throw new Error("not a user");
    const kept = (await this.userByPass(fresh.pass)) ?? (await this.userByLabel(fresh.label));
    if (kept) return kept;
    const text = JSON.stringify(fresh);
    const labels = path.join(this.userDir, "label");
    if (!(await writeOnce(labels, fresh.label, text))) {
      const other = await this.userByLabel(fresh.label);
      if (!other) throw new StoreError();
      return other;
    }
    if (await writeOnce(path.join(this.userDir, "pass"), passKey(fresh.pass), text)) return fresh;
    await unlink(path.join(labels, `${fresh.label}.json`)).catch(() => {});
    const other = await this.userByPass(fresh.pass);
    if (!other) throw new StoreError();
    return other;
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
 * The store this server uses. With ARKIV_PRIVATE_KEY (or ARKIV_OWNER, to read only) the records,
 * picture pointers, users and photo names live on Arkiv; otherwise each is a file under DATA_DIR
 * (default `.data`).
 */
export function records(): RecordStore {
  if (store) return store;
  const arkiv = arkivSettings();
  const data = process.env.DATA_DIR || ".data";
  store = arkiv
    ? new ArkivStore(arkiv)
    : new FileStore(
        path.resolve(data, "seals"),
        path.resolve(data, "pictures"),
        path.resolve(data, "users"),
        path.resolve(data, "names"),
      );
  return store;
}
