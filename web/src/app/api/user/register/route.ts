import { after } from "next/server";
import { addressOf, createUserName, userEns } from "@/lib/naming";
import { isLabel, records, type UserRecord } from "@/lib/records";
import { treeRoot, userName, userTaken } from "@/lib/tree";
import {
  boundNullifier,
  sessionFor,
  userSignal,
  worldAccepts,
  worldConfig,
  type WorldConfig,
} from "@/lib/world";

// The name is created on chain after the answer is sent, given up to 50 s. 300 s is the most a
// function may run on the Hobby plan with fluid compute, which new projects have.
export const maxDuration = 300;

/** `session` is what the client gives back with each photo, to tie it to this person. */
function registered(config: WorldConfig, user: UserRecord, ens: "pending" | "done") {
  return Response.json({
    state: "registered",
    name: user.name,
    pass: user.pass,
    address: addressOf(user),
    ens,
    session: sessionFor(config, user.pass),
  });
}

function refused(reason: string, status: number, label: unknown) {
  const labelText = typeof label === "string" ? label.slice(0, 32) : "-";
  console.log(`user/register: refused ${reason} label=${labelText}`);
  return Response.json({ state: "refused", reason }, { status });
}

/**
 * Gives a person a name of their own, <label>.users.<root>, for a World proof made for
 * `user:<label>` with the join action. Every answer is a word from a short fixed list.
 *
 * One person keeps one name: a pass that has a name already gets that name back, and no new one.
 * A label kept for another pass, or already on chain, is `taken`. A new name is kept in the store
 * at once and answered with `ens: "pending"`; it is created on chain after the answer is sent.
 * Every registered answer carries `session` (see sessionFor), for the person's photos.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { label?: unknown; result?: unknown }
    | null;
  if (!isLabel(body?.label)) return refused("label", 400, body?.label);
  const label = body.label;
  const config = worldConfig();
  if (!config || !treeRoot()) return refused("not-set-up", 503, label);
  const nullifier = boundNullifier(body.result, userSignal(label), config, config.joinAction);
  if (nullifier === null) return refused("not-this-name", 422, label);
  // World takes one proof per person for the join action, so every refusal that does not need
  // the proof checked is made before World is asked: a proof World accepted is never wasted.
  let mine: UserRecord | null;
  let held: UserRecord | null;
  try {
    mine = await records().userByPass(nullifier);
    held = mine ? null : await records().userByLabel(label);
  } catch {
    return refused("store", 503, label);
  }
  if (!mine && (held || (await userTaken(label).catch(() => false)))) {
    return refused("taken", 409, label);
  }
  if (!(await worldAccepts(body.result, config, config.joinAction))) {
    return refused("not-verified", 422, label);
  }
  if (mine) {
    const ens = await userEns(mine.label);
    // A name kept here that is not on chain yet is asked for again, in case the first try failed.
    if (ens === "pending") after(() => createUserName(mine.label, mine.pass));
    console.log(`user/register: known label=${mine.label} session issued`);
    return registered(config, mine, ens);
  }
  const at = new Date().toISOString();
  let kept: UserRecord;
  try {
    const address = addressOf({ address: null, pass: nullifier });
    kept = await records().putUser({ label, name: userName(label), pass: nullifier, address, at });
  } catch (error) {
    // World has taken this person's proof, so they cannot make another: keep what is needed to
    // put the name in by hand.
    console.error(
      `user/register: store failed after World accepted label=${label} pass=${nullifier}: ${String(error)}`,
    );
    return refused("store", 503, label);
  }
  // Another request may have kept this label, or another name for this pass, first.
  if (kept.pass !== nullifier) {
    console.error(`user/register: taken after World accepted label=${label} pass=${nullifier}`);
    return refused("taken", 409, label);
  }
  if (kept.label === label && kept.at === at) {
    after(() => createUserName(label, nullifier));
    console.log(`user/register: registered label=${label} session issued`);
    return registered(config, kept, "pending");
  }
  console.log(`user/register: known label=${kept.label} session issued`);
  return registered(config, kept, await userEns(kept.label));
}
