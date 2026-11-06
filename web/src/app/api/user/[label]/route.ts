import { userEns } from "@/lib/naming";
import {
  isLabel,
  pictureLink,
  records,
  type PassSeal,
  type UserRecord,
} from "@/lib/records";

const headers = { "cache-control": "no-store" };

/**
 * Says whether a label is a person's name, whether that name is on chain yet, and which seals the
 * person authorised, newest first, each with its event and picture. The pass is not given.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ label: string }> }) {
  const { label } = await params;
  if (!isLabel(label)) return Response.json({ state: "none" }, { status: 404, headers });
  let user: UserRecord | null;
  let images;
  try {
    user = await records().userByLabel(label);
    if (!user) return Response.json({ state: "none" }, { headers });
    const seals: PassSeal[] = await records().byPass(user.pass);
    images = await Promise.all(
      seals.map(async ({ hash, at }) => {
        const [record, picture] = await Promise.all([
          records().get(hash),
          records().getPicture(hash),
        ]);
        return { hash, event: record?.event ?? null, at, picture: pictureLink(picture) };
      }),
    );
  } catch {
    return Response.json({ state: "unknown", reason: "store" }, { status: 503, headers });
  }
  return Response.json(
    {
      state: "listed",
      label: user.label,
      name: user.name,
      ens: { state: await userEns(user.label) },
      images,
    },
    { headers },
  );
}
