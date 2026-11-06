import { deskName, deskOf, ethClient, vouch, type Vouch } from "@/lib/ens";
import { records, type SealRecord } from "@/lib/records";
import { actingAccount } from "@/lib/signin";
import { boundNullifier, isSealHash, worldAccepts, worldConfig } from "@/lib/world";

/** `vouch` says what the desk answered about a name given with this authorisation, if any. */
function verified(record: SealRecord, asked: Vouch | null = null) {
  return Response.json({
    state: "verified",
    pass: record.pass,
    credential: record.credential,
    account: record.account,
    name: record.name,
    desk: record.name ? deskOf(record.name) : deskName(),
    vouch: asked,
    at: record.at,
  });
}

/** The record of seals could not be read or written; nothing is said about this seal. */
function storeFailed() {
  return Response.json({ state: "refused", reason: "store" }, { status: 503 });
}

/**
 * Finishes one authorisation. The proof must be tied to this seal's hash, and World must
 * accept it. Every answer is a word from a short fixed list. The first authorisation of a seal
 * is kept; a later one gets the kept record back and changes nothing. When sign-in is set up,
 * the person must still be freshly signed in, and the record keeps a short name for the account.
 *
 * A person may also give their name at the desk. The name is kept with the record only when the
 * desk vouches for it, as the chain says now: it is a member of the desk, and it carries this
 * authorisation's pass, or the signed-in account. A name the desk does not vouch for is dropped;
 * the authorisation itself still stands.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { hash?: unknown; result?: unknown; name?: unknown }
    | null;
  if (!isSealHash(body?.hash)) {
    return Response.json({ state: "refused", reason: "hash" }, { status: 400 });
  }
  const config = worldConfig();
  if (!config) {
    return Response.json({ state: "refused", reason: "not-set-up" }, { status: 503 });
  }
  let kept: SealRecord | null;
  try {
    kept = await records().get(body.hash);
  } catch {
    return storeFailed();
  }
  if (kept) return verified(kept);
  const account = await actingAccount();
  if (account === false) {
    return Response.json({ state: "refused", reason: "sign-in" }, { status: 401 });
  }
  const nullifier = boundNullifier(body.result, body.hash, config);
  if (nullifier === null) {
    return Response.json({ state: "refused", reason: "not-this-seal" }, { status: 422 });
  }
  if (!(await worldAccepts(body.result, config))) {
    return Response.json({ state: "refused", reason: "not-verified" }, { status: 422 });
  }
  let name: string | null = null;
  let asked: Vouch | null = null;
  if (typeof body.name === "string" && body.name.trim() !== "") {
    const desk = deskName();
    const answer = desk
      ? await vouch(ethClient(), desk, body.name, nullifier, account)
      : { vouch: "not-vouched" as const, name: null };
    asked = answer.vouch;
    name = answer.name;
  }
  let record: SealRecord;
  try {
    record = await records().put({
      hash: body.hash,
      pass: nullifier,
      credential: config.credential,
      account,
      name,
      event: null,
      at: new Date().toISOString(),
    });
  } catch {
    return storeFailed();
  }
  return verified(record, asked);
}
