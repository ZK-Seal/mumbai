import { boundNullifier, isSealHash, worldAccepts, worldConfig } from "@/lib/world";

/**
 * Finishes one authorisation. The proof must be tied to this seal's hash, and World must
 * accept it. Every answer is a word from a short fixed list.
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
  const nullifier = boundNullifier(body.result, body.hash, config);
  if (nullifier === null) {
    return Response.json({ state: "refused", reason: "not-this-seal" }, { status: 422 });
  }
  if (!(await worldAccepts(body.result, config))) {
    return Response.json({ state: "refused", reason: "not-verified" }, { status: 422 });
  }
  return Response.json({ state: "verified", pass: nullifier, credential: config.credential });
}
