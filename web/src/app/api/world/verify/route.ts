import { deskName, deskOf, ethClient, vouch, type Vouch } from "@/lib/ens";
import {
  isEvent,
  keepAfterWorld,
  records,
  type SealRecord,
  type UserRecord,
} from "@/lib/records";
import {
  actionFor,
  boundNullifier,
  isSealHash,
  pictureToken,
  sessionPass,
  worldAccepts,
  worldConfig,
  type WorldConfig,
} from "@/lib/world";

/**
 * `vouch` says what the desk answered about a name given with this authorisation, if any.
 * `token` is the picture upload token, given only when this very call kept a new record.
 */
function verified(record: SealRecord, asked: Vouch | null = null, token: string | null = null) {
  return Response.json({
    state: "verified",
    pass: record.pass,
    credential: record.credential,
    account: record.account,
    name: record.name,
    desk: record.name ? deskOf(record.name) : deskName(),
    vouch: asked,
    event: record.event,
    at: record.at,
    ...(token ? { picture_token: token } : {}),
  });
}

/** The record of seals could not be read or written; nothing is said about this seal. */
function storeFailed(hash: string) {
  return refused("store", 503, hash);
}

/**
 * The named person a session given with a photo stands for, or null when none was given, or it
 * is not one of ours, or its pass has no user. A session that does not hold is only logged: the
 * photo is then authorised for an anonymous person, never refused. Throws a StoreError if the
 * user cannot be read.
 */
async function sessionUser(config: WorldConfig, given: unknown, hash: string) {
  if (given === undefined || given === null) return null;
  const pass = sessionPass(config, given);
  const user: UserRecord | null = pass === null ? null : await records().userByPass(pass);
  if (!user) console.log(`world/verify: session not ours hash=${hash.slice(0, 8)}, anonymous`);
  return user;
}

function refused(reason: string, status: number, hash: unknown) {
  const hashText = typeof hash === "string" ? hash.slice(0, 8) : "-";
  console.log(`world/verify: refused ${reason} hash=${hashText}`);
  return Response.json({ state: "refused", reason }, { status });
}

/**
 * Finishes one authorisation. The proof must be tied to this seal's hash and made for the
 * action the request route handed out (see actionFor: by default one of this photo's own), and
 * World must accept it. Every answer
 * is a word from a short fixed list. The first authorisation of a seal is kept; a later one gets
 * the kept record back and changes nothing. No account is kept with the record.
 *
 * A person may also give their name at the desk. The name is kept with the record only when the
 * desk vouches for it, as the chain says now: it is a member of the desk, and it carries this
 * authorisation's pass. A name the desk does not vouch for is dropped; the authorisation itself
 * still stands. When no name is given, the record keeps the person's user name, the one their
 * pass holds, or null when they have none.
 *
 * Whose photo it is. With per-photo actions the proof's nullifier is this photo's alone, never
 * the person's pass. So the client may give `session`, the one register answered with: when it
 * holds, the record keeps the person's pass (their photos group under it) and their name. That
 * link between a photo and a named person is our server's session; the photo still carries its
 * own World proof of a unique human. Without a session, or with one that does not hold, the
 * record keeps the proof's nullifier as its pass: an anonymous person of one photo, with no name.
 *
 * A person with a name may also publish with no `result` at all, only their `session`. Their
 * name was proven with World once, when they joined; the photo carries its zkSeal hash and is
 * filed under that name. So the photo is tied to the person with the World ID-checked name by the app's session,
 * not by a per-photo World proof, and World is not asked again. Anonymous photos still carry
 * their own proof. With no `result`, a session that does not hold is refused as `session`.
 *
 * The answer that keeps a new record also carries `picture_token`, which lets this client upload
 * the seal's picture. An answer with a record kept before never carries it: anyone can reach that
 * answer by posting anything for a known hash.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { hash?: unknown; result?: unknown; name?: unknown; event?: unknown; session?: unknown }
    | null;
  if (!isSealHash(body?.hash)) {
    return refused("hash", 400, body?.hash);
  }
  if (body.event !== undefined && !isEvent(body.event)) {
    return refused("event", 400, body?.hash);
  }
  const event = isEvent(body.event) ? body.event : null;
  const config = worldConfig();
  if (!config) {
    return refused("not-set-up", 503, body?.hash);
  }
  if (body.result === undefined || body.result === null) {
    return bySession(config, body.hash, body.session, body.name, event);
  }
  let kept: SealRecord | null;
  try {
    kept = await records().get(body.hash);
  } catch {
    return storeFailed(body.hash);
  }
  if (kept) return verified(kept);
  const action = actionFor(config, body.hash, event);
  const nullifier = boundNullifier(body.result, body.hash, config, action);
  if (nullifier === null) {
    return refused("not-this-seal", 422, body?.hash);
  }
  if (!(await worldAccepts(body.result, config, action))) {
    return refused("not-verified", 422, body?.hash);
  }
  let user: UserRecord | null;
  try {
    // In `one` mode a person with a name kept before join had its own action has this nullifier.
    user =
      (await sessionUser(config, body.session, body.hash)) ??
      (await records().userByPass(nullifier));
  } catch {
    return storeFailed(body.hash);
  }
  const pass = user?.pass ?? nullifier;
  return keep(config, body.hash, pass, user, body.name, event, "");
}

/**
 * Files a photo under a person with a name on their session alone, with no World proof of its
 * own: the person proved themselves with World when they joined, and the session ties this photo
 * to them. Nothing is asked of World here.
 */
async function bySession(
  config: WorldConfig,
  hash: string,
  given: unknown,
  name: unknown,
  event: string | null,
) {
  const pass = sessionPass(config, given);
  let user: UserRecord | null;
  try {
    user = pass === null ? null : await records().userByPass(pass);
  } catch {
    return storeFailed(hash);
  }
  if (!user) return refused("session", 401, hash);
  let kept: SealRecord | null;
  try {
    kept = await records().get(hash);
  } catch {
    return storeFailed(hash);
  }
  if (kept) return verified(kept);
  return keep(config, hash, user.pass, user, name, event, " (by session)");
}

/** Keeps the record of a seal that holds, first write wins, and answers with it. */
async function keep(
  config: WorldConfig,
  hash: string,
  pass: string,
  user: UserRecord | null,
  given: unknown,
  event: string | null,
  how: string,
) {
  let name: string | null = user?.name ?? null;
  let asked: Vouch | null = null;
  if (typeof given === "string" && given.trim() !== "") {
    const desk = deskName();
    const answer = desk
      ? await vouch(ethClient(), desk, given, pass, null)
      : { vouch: "not-vouched" as const, name: null };
    asked = answer.vouch;
    name = answer.name;
  }
  const at = new Date().toISOString();
  const record = await keepAfterWorld({
    hash,
    pass,
    credential: config.credential,
    account: null,
    name,
    event,
    at,
  });
  if (!record) return storeFailed(hash);
  // Another request may have kept a record for this seal first; then this call made nothing new.
  const created = record.pass === pass && record.at === at;
  const person = user?.label ?? "anonymous";
  console.log(`world/verify: verified hash=${hash.slice(0, 8)} person=${person}${how}`);
  return verified(record, asked, created ? pictureToken(config, hash) : null);
}
