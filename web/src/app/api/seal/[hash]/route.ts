import { pictureLink, records, type PictureRecord, type SealRecord } from "@/lib/records";
import { isSealHash } from "@/lib/world";

/**
 * Says whether a person has authorised this seal, with which pass and which account, and at
 * which event, and where its picture is kept on Swarm, if one was kept.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!isSealHash(hash)) {
    return Response.json({ state: "none" }, { status: 404 });
  }
  let record: SealRecord | null;
  let picture: PictureRecord | null;
  try {
    record = await records().get(hash);
    picture = record ? await records().getPicture(hash) : null;
  } catch {
    return Response.json({ state: "unknown", reason: "store" }, { status: 503 });
  }
  if (!record) return Response.json({ state: "none" });
  return Response.json({
    state: "authorised",
    pass: record.pass,
    credential: record.credential,
    account: record.account,
    name: record.name,
    event: record.event,
    at: record.at,
    picture: pictureLink(picture),
  });
}
