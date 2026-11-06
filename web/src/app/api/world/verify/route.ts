import { records, type SealRecord } from "@/lib/records";
import { boundNullifier, isSealHash, worldAccepts, worldConfig } from "@/lib/world";

function verified(record: SealRecord) {
  return Response.json({
    state: "verified",
    pass: record.pass,
    credential: record.credential,
    at: record.at,
  });
}

/**
 * Finishes one authorisation. The proof must be tied to this seal's hash, and World must
 * accept it. Every answer is a word from a short fixed list. The first authorisation of a seal
 * is kept; a later one gets the kept record back and changes nothing.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | { hash?: unknown; result?: unknown }
    | null;
  if (!isSealHash(body?.hash)) {
    return Response.json({ state: "refused", reason: "hash" }, { status: 400 });
  }
  const config = worldConfig();
  if (!config) {
    return Response.json({ state: "refused", reason: "not-set-up" }, { status: 503 });
  }
  const kept = await records().get(body.hash);
  if (kept) return verified(kept);
  const nullifier = boundNullifier(body.result, body.hash, config);
  if (nullifier === null) {
    return Response.json({ state: "refused", reason: "not-this-seal" }, { status: 422 });
  }
  if (!(await worldAccepts(body.result, config))) {
    return Response.json({ state: "refused", reason: "not-verified" }, { status: 422 });
  }
  const record = await records().put({
    hash: body.hash,
    pass: nullifier,
    credential: config.credential,
    at: new Date().toISOString(),
  });
  return verified(record);
}
