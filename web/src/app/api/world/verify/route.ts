import { deskName, deskOf, ethClient, vouch, type Vouch } from "@/lib/ens";
import { isEvent, records, type SealRecord } from "@/lib/records";
import {
  actionFor,
  boundNullifier,
  isSealHash,
  pictureToken,
  worldAccepts,
  worldConfig,
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

function refused(reason: string, status: number, hash: unknown) {
  const hashText = typeof hash === "string" ? hash.slice(0, 8) : "-";
  console.log(`world/verify: refused ${reason} hash=${hashText}`);
  return Response.json({ state: "refused", reason }, { status });
}

/**
 * Finishes one authorisation. The proof must be tied to this seal's hash and made for the
 * action the request route handed out (see actionFor), and World must accept it. Every answer
 * is a word from a short fixed list. The first authorisation of a seal is kept; a later one gets
 * the kept record back and changes nothing. No account is kept with the record.
 *
 * A person may also give their name at the desk. The name is kept with the record only when the
 * desk vouches for it, as the chain says now: it is a member of the desk, and it carries this
 * authorisation's pass. A name the desk does not vouch for is dropped; the authorisation itself
 * still stands. When no name is given, the record keeps the person's user name, the one their
 * pass holds, or null when they have none.
 *
 * The answer that keeps a new record also carries `picture_token`, which lets this client upload
 * the seal's picture. An answer with a record kept before never carries it: anyone can reach that
 * answer by posting anything for a known hash.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { hash?: unknown; result?: unknown; name?: unknown; event?: unknown }
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
  let name: string | null = null;
  let asked: Vouch | null = null;
  if (typeof body.name === "string" && body.name.trim() !== "") {
    const desk = deskName();
    const answer = desk
      ? await vouch(ethClient(), desk, body.name, nullifier, null)
      : { vouch: "not-vouched" as const, name: null };
    asked = answer.vouch;
    name = answer.name;
  } else {
    try {
      name = (await records().userByPass(nullifier))?.name ?? null;
    } catch {
      return storeFailed(body.hash);
    }
  }
  const at = new Date().toISOString();
  let record: SealRecord;
  try {
    record = await records().put({
      hash: body.hash,
      pass: nullifier,
      credential: config.credential,
      account: null,
      name,
      event,
      at,
    });
  } catch {
    return storeFailed(body.hash);
  }
  // Another request may have kept a record for this seal first; then this call made nothing new.
  const created = record.pass === nullifier && record.at === at;
  const pass = record.pass.slice(0, 10);
  console.log(`world/verify: verified hash=${body.hash.slice(0, 8)} pass=${pass}`);
  return verified(record, asked, created ? pictureToken(config, body.hash) : null);
}
