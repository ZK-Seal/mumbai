import { records, type SealRecord } from "@/lib/records";
import { registerImage, registerUser, TreeError, userTaken } from "@/lib/tree";

/** Where a person's name stands on chain: asked for, or there. */
export type EnsState = "pending" | "done";

/** Whether the user's name is on chain yet. A chain that cannot be read says pending. */
export async function userEns(label: string): Promise<EnsState> {
  try {
    return (await userTaken(label)) ? "done" : "pending";
  } catch {
    return "pending";
  }
}

function why(error: unknown): string {
  return error instanceof TreeError ? error.reason : "chain";
}

/** Labels whose name is being created by this process, so one is never asked for twice at once. */
const creatingUsers = new Set<string>();

/**
 * Creates the user's name on chain, and says in one log line how it went. Meant to run after the
 * answer is sent: it takes from 15 seconds to a minute. Nothing is done while the same label is
 * already being created here.
 */
export async function createUserName(label: string, pass: string): Promise<void> {
  if (creatingUsers.has(label)) return;
  creatingUsers.add(label);
  try {
    const made = await registerUser(label, pass);
    console.info(`Names: created ${made.name} in ${made.tx}`);
  } catch (error) {
    console.warn(`Names: could not create the name for ${label}: ${why(error)}`);
  } finally {
    creatingUsers.delete(label);
  }
}

/** How many numbers a photo's name tries before it is given up for now. */
const IMAGE_NAME_TRIES = 5;

/** The photo names of each event, one after another, so two photos never count the same number. */
const eventQueues = new Map<string, Promise<unknown>>();

/** Seals whose photo is being named by this process. */
const namingImages = new Set<string>();

/**
 * Names the photo of one seal on chain: image<N> under its event, with N one more than the photo
 * names kept for that event so far. A number that holds another seal already is skipped, up to
 * IMAGE_NAME_TRIES numbers. Once the name is there it is kept, so the seal is not named twice.
 * Only a seal at an event, authorised by a person with a user name, is named. Meant to run after
 * the answer is sent, and says in one log line how it went.
 */
export async function nameImage(record: SealRecord, ref: string): Promise<void> {
  const { hash, event } = record;
  if (event === null || namingImages.has(hash)) return;
  namingImages.add(hash);
  const before = eventQueues.get(event) ?? Promise.resolve();
  const run = before.then(() => nameNow(record, event, ref));
  const after = run.catch(() => {});
  eventQueues.set(event, after);
  try {
    await run;
  } catch (error) {
    console.warn(`Names: could not name the photo of ${hash.slice(0, 16)}: ${why(error)}`);
  } finally {
    namingImages.delete(hash);
    if (eventQueues.get(event) === after) eventQueues.delete(event);
  }
}

async function nameNow(record: SealRecord, event: string, ref: string): Promise<void> {
  const store = records();
  const [user, kept] = await Promise.all([
    store.userByPass(record.pass),
    store.getName(record.hash),
  ]);
  if (!user || kept) return;
  let n = (await store.namesByEvent(event)).length + 1;
  for (let tries = 0; tries < IMAGE_NAME_TRIES; tries++, n++) {
    // A number already holding this seal (a name created before its record was kept) is kept;
    // one holding another seal is "taken", and the next number is tried.
    const label = `image${n}`;
    let made;
    try {
      made = await registerImage(event, label, { hash: record.hash, by: user.name, ref });
    } catch (error) {
      if (error instanceof TreeError && error.reason === "taken") continue;
      throw error;
    }
    const at = new Date().toISOString();
    await store.putName({ hash: record.hash, event, name: made.name, tx: made.tx, at });
    console.info(`Names: created ${made.name} in ${made.tx}`);
    return;
  }
  throw new TreeError("taken");
}
