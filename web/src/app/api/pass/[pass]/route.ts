import { isPass, records, type PassSeal } from "@/lib/records";

/** Lists the newest seals authorised with this pass: each seal's hash and when it was authorised. */
export async function GET(_request: Request, { params }: { params: Promise<{ pass: string }> }) {
  const { pass } = await params;
  if (!isPass(pass)) {
    return Response.json({ state: "refused", reason: "pass" }, { status: 400 });
  }
  let seals: PassSeal[];
  try {
    seals = await records().byPass(pass);
  } catch {
    return Response.json({ state: "unknown", reason: "store" }, { status: 503 });
  }
  return Response.json({ state: "listed", seals });
}
