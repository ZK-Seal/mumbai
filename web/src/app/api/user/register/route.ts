import { after } from "next/server";
import { addressOf, createUserName, userEns } from "@/lib/naming";
import { isLabel, records, type UserRecord } from "@/lib/records";
import { treeRoot, userName, userTaken } from "@/lib/tree";
import { boundNullifier, userSignal, worldAccepts, worldConfig } from "@/lib/world";

// The name is created on chain after the answer is sent, given up to 50 s. 300 s is the most a
// function may run on the Hobby plan with fluid compute, which new projects have.
export const maxDuration = 300;

function registered(user: UserRecord, ens: "pending" | "done") {
  return Response.json({
    state: "registered",
    name: user.name,
    pass: user.pass,
    address: addressOf(user),
    ens,
  });
}

function refused(reason: string, status: number) {
  return Response.json({ state: "refused", reason }, { status });
}

/**
 * Gives a person a name of their own, <label>.users.<root>, for a World proof made for
 * `user:<label>` with the single World action. Every answer is a word from a short fixed list.
 *
 * One person keeps one name: a pass that has a name already gets that name back, and no new one.
 * A label kept for another pass, or already on chain, is `taken`. A new name is kept in the store
 * at once and answered with `ens: "pending"`; it is created on chain after the answer is sent.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { label?: unknown; result?: unknown }
    | null;
  if (!isLabel(body?.label)) return refused("label", 400);
  const label = body.label;
  const config = worldConfig();
  if (!config || !treeRoot()) return refused("not-set-up", 503);
  const nullifier = boundNullifier(body.result, userSignal(label), config, config.action);
  if (nullifier === null) return refused("not-this-name", 422);
  if (!(await worldAccepts(body.result, config, config.action))) {
    return refused("not-verified", 422);
  }
  let mine: UserRecord | null;
  let held: UserRecord | null;
  try {
    mine = await records().userByPass(nullifier);
    held = mine ? null : await records().userByLabel(label);
  } catch {
    return refused("store", 503);
  }
  if (mine) {
    const ens = await userEns(mine.label);
    // A name kept here that is not on chain yet is asked for again, in case the first try failed.
    if (ens === "pending") after(() => createUserName(mine.label, mine.pass));
    return registered(mine, ens);
  }
  if (held || (await userTaken(label).catch(() => false))) return refused("taken", 409);
  const at = new Date().toISOString();
  let kept: UserRecord;
  try {
    const address = addressOf({ address: null, pass: nullifier });
    kept = await records().putUser({ label, name: userName(label), pass: nullifier, address, at });
  } catch {
    return refused("store", 503);
  }
  // Another request may have kept this label, or another name for this pass, first.
  if (kept.pass !== nullifier) return refused("taken", 409);
  if (kept.label === label && kept.at === at) {
    after(() => createUserName(label, nullifier));
    return registered(kept, "pending");
  }
  return registered(kept, await userEns(kept.label));
}
