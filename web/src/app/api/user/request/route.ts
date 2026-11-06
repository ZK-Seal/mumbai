import { isLabel, records, type UserRecord } from "@/lib/records";
import { treeRoot, userTaken } from "@/lib/tree";
import { requestContext, userSignal, worldConfig } from "@/lib/world";

function refused(reason: string, status: number, label: unknown) {
  const labelText = typeof label === "string" ? label.slice(0, 32) : "-";
  console.log(`user/request: refused ${reason} label=${labelText}`);
  return Response.json({ state: "refused", reason }, { status });
}

/**
 * Starts one user name: hands the page what the World app needs for a proof given for this
 * label. A label that is kept already, or is on chain already, is answered `taken`.
 *
 * The proof is made for the join action (WORLD_JOIN_ACTION, default `join`), which nothing else
 * uses: the World app gives one proof per person and action, so a photo's action must never be
 * this one. The pass it gives is kept with the user; register answers with a session holding it,
 * which ties the person's photos to their name (see sessionFor).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { label?: unknown } | null;
  if (!isLabel(body?.label)) {
    return refused("label", 400, body?.label);
  }
  const label = body.label;
  const config = worldConfig();
  if (!config || !treeRoot()) {
    return refused("not-set-up", 503, body?.label);
  }
  let kept: UserRecord | null;
  try {
    kept = await records().userByLabel(label);
  } catch {
    return refused("store", 503, body?.label);
  }
  if (kept || (await userTaken(label).catch(() => false))) {
    return Response.json({ state: "taken" });
  }
  const signal = userSignal(label);
  return Response.json({
    state: "ready",
    app_id: config.appId,
    action: config.joinAction,
    environment: config.environment,
    credential: config.credential,
    signal,
    rp_context: requestContext(config, config.joinAction),
  });
}
