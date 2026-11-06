import { isLabel, records, type UserRecord } from "@/lib/records";
import { treeRoot, userTaken } from "@/lib/tree";
import { requestContext, userSignal, worldConfig } from "@/lib/world";

/**
 * Starts one user name: hands the page what the World app needs for a proof given for this
 * label. A label that is kept already, or is on chain already, is answered `taken`.
 *
 * The proof is made for the single World action, the one seals use, so the pass it gives is the
 * pass this person authorises every seal with: that is how a seal is tied to their name.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { label?: unknown } | null;
  if (!isLabel(body?.label)) {
    return Response.json({ state: "refused", reason: "label" }, { status: 400 });
  }
  const label = body.label;
  const config = worldConfig();
  if (!config || !treeRoot()) {
    return Response.json({ state: "refused", reason: "not-set-up" }, { status: 503 });
  }
  let kept: UserRecord | null;
  try {
    kept = await records().userByLabel(label);
  } catch {
    return Response.json({ state: "refused", reason: "store" }, { status: 503 });
  }
  if (kept || (await userTaken(label).catch(() => false))) {
    return Response.json({ state: "taken" });
  }
  const signal = userSignal(label);
  return Response.json({
    state: "ready",
    app_id: config.appId,
    action: config.action,
    environment: config.environment,
    credential: config.credential,
    signal,
    rp_context: requestContext(config, config.action),
  });
}
