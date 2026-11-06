import { records } from "@/lib/records";
import { isSealHash, requestContext, worldConfig } from "@/lib/world";

/**
 * Starts one authorisation: hands the page what the World app needs for this seal. A seal that
 * is already authorised gets its record back instead.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { hash?: unknown } | null;
  if (!isSealHash(body?.hash)) {
    return Response.json({ state: "refused", reason: "hash" }, { status: 400 });
  }
  const kept = await records().get(body.hash);
  if (kept) {
    return Response.json({
      state: "authorised",
      pass: kept.pass,
      credential: kept.credential,
      at: kept.at,
    });
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
