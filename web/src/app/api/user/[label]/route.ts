import { addressOf, userEns } from "@/lib/naming";
import {
  imageState,
  isLabel,
  pictureLink,
  records,
  type PassSeal,
  type UserRecord,
} from "@/lib/records";

const headers = { "cache-control": "no-store" };

/**
 * Says whether a label is a person's name, whether that name is on chain yet, and which seals the
 * person authorised, newest first (at most PASS_LIST_LIMIT), each with its event, picture and the
 * photo's own name (as the seal answer gives it), and the person's own address, which holds their
 * names on chain. The pass is not given.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ label: string }> }) {
  const { label } = await params;
  if (!isLabel(label)) return Response.json({ state: "none" }, { status: 404, headers });
  let user: UserRecord | null;
  let images;
  try {
    user = await records().userByLabel(label);
    if (!user) return Response.json({ state: "none" }, { headers });
    const name = user.name;
    const seals: PassSeal[] = await records().byPass(user.pass);
    images = await Promise.all(
      seals.map(async ({ hash, at }) => {
        const [record, picture, named] = await Promise.all([
          records().get(hash),
          records().getPicture(hash),
          records().getName(hash),
        ]);
        const event = record?.event ?? null;
        const image = imageState(named, picture, event, name);
        return { hash, event, at, picture: pictureLink(picture), image };
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
      address: addressOf(user),
      ens: { state: await userEns(user.label) },
      images,
    },
    { headers },
  );
}
