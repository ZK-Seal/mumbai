import { records, type SealRecord } from "@/lib/records";
import { isSealHash } from "@/lib/world";

/** Says whether a person has authorised this seal, with which pass and which account. */
export async function GET(_request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!isSealHash(hash)) {
    return Response.json({ state: "none" }, { status: 404 });
  }
  let record: SealRecord | null;
  try {
    record = await records().get(hash);
  } catch {
    return Response.json({ state: "unknown", reason: "store" }, { status: 503 });
  }
  if (!record) return Response.json({ state: "none" });
  return Response.json({
    state: "authorised",
    pass: record.pass,
    credential: record.credential,
    account: record.account,
    at: record.at,
  });
}
