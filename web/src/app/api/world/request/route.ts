import { isEvent, records, type SealRecord } from "@/lib/records";
import { actionFor, isSealHash, requestContext, worldConfig } from "@/lib/world";

function refused(reason: string, status: number, hash: unknown) {
  const hashText = typeof hash === "string" ? hash.slice(0, 8) : "-";
  console.log(`world/request: refused ${reason} hash=${hashText}`);
  return Response.json({ state: "refused", reason }, { status });
}

/**
 * Starts one authorisation: hands the page what the World app needs for this seal. A seal that
 * is already authorised gets its record back instead.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { hash?: unknown; event?: unknown }
    | null;
  if (!isSealHash(body?.hash)) {
    return refused("hash", 400, body?.hash);
  }
  if (body.event !== undefined && !isEvent(body.event)) {
    return refused("event", 400, body?.hash);
  }
  let kept: SealRecord | null;
  try {
    kept = await records().get(body.hash);
  } catch {
    return refused("store", 503, body?.hash);
  }
  if (kept) {
    return Response.json({
      state: "authorised",
      pass: kept.pass,
      credential: kept.credential,
      account: kept.account,
      name: kept.name,
      event: kept.event,
      at: kept.at,
    });
  }
  const config = worldConfig();
  if (!config) {
    return refused("not-set-up", 503, body?.hash);
  }
  const action = actionFor(config, body.hash, isEvent(body.event) ? body.event : null);
  return Response.json({
    state: "ready",
    app_id: config.appId,
    action,
    environment: config.environment,
    credential: config.credential,
    signal: body.hash,
    rp_context: requestContext(config, action),
  });
}
