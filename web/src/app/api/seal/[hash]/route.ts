import {
  imageState,
  pictureLink,
  records,
  type NameRecord,
  type PictureRecord,
  type SealRecord,
  type UserRecord,
} from "@/lib/records";
import { isSealHash } from "@/lib/world";

/**
 * Says whether a person has authorised this seal, with which pass and which account, and at
 * which event, and where its picture is kept on Swarm, if one was kept. `name` is the person's
 * user name, or else the name a desk vouched for, or null. `image` is the photo's own name:
 * `{name, state: "done"}`, `{state: "pending"}` while it is being created, or null.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!isSealHash(hash)) {
    return Response.json({ state: "none" }, { status: 404 });
  }
  let record: SealRecord | null;
  let picture: PictureRecord | null = null;
  let named: NameRecord | null = null;
  let user: UserRecord | null = null;
  try {
    record = await records().get(hash);
    if (record) {
      [picture, named, user] = await Promise.all([
        records().getPicture(hash),
        records().getName(hash),
        records().userByPass(record.pass),
      ]);
    }
  } catch {
    return Response.json({ state: "unknown", reason: "store" }, { status: 503 });
  }
  if (!record) return Response.json({ state: "none" });
  return Response.json({
    state: "authorised",
    pass: record.pass,
    credential: record.credential,
    account: record.account,
    name: user?.name ?? record.name,
    event: record.event,
    at: record.at,
    picture: pictureLink(picture),
    image: imageState(named, picture, record.event, user?.name ?? null),
  });
}
