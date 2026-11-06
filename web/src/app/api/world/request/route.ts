import { isEvent, records, type SealRecord } from "@/lib/records";
import { actingAccount } from "@/lib/signin";
import { isSealHash, requestContext, worldConfig } from "@/lib/world";

/**
 * Starts one authorisation: hands the page what the World app needs for this seal. A seal that
 * is already authorised gets its record back instead. When sign-in is set up, only someone who
 * signed in with World in the last few minutes, with the required verification, may start.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { hash?: unknown; event?: unknown }
    | null;
  if (!isSealHash(body?.hash)) {
    return Response.json({ state: "refused", reason: "hash" }, { status: 400 });
  }
  if (body.event !== undefined && !isEvent(body.event)) {
    return Response.json({ state: "refused", reason: "event" }, { status: 400 });
  }
  let kept: SealRecord | null;
  try {
    kept = await records().get(body.hash);
  } catch {
    return Response.json({ state: "refused", reason: "store" }, { status: 503 });
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
  if ((await actingAccount()) === false) {
    return Response.json({ state: "refused", reason: "sign-in" }, { status: 401 });
  }
  const config = worldConfig();
  if (!config) {
    return Response.json({ state: "refused", reason: "not-set-up" }, { status: 503 });
  }
  return Response.json({
    state: "ready",
    app_id: config.appId,
    action: config.action,
    environment: config.environment,
    credential: config.credential,
    signal: body.hash,
    rp_context: requestContext(config),
  });
}
