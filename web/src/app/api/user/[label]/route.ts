import { after } from "next/server";
import { addressOf, createUserName, userEns } from "@/lib/naming";
import {
  imageState,
  normalLabel,
  pictureLink,
  records,
  type PassSeal,
  type UserRecord,
} from "@/lib/records";

const headers = { "cache-control": "no-store" };

/** When each label's pending name was last asked for here, so a polling page asks once a minute. */
const RETRY_MS = 60_000;
const lastRetry = new Map<string, number>();

/** Asks again for a name kept here but not on chain yet, at most once a minute per label. */
function retryName(user: UserRecord): void {
  const now = Date.now();
  const last = lastRetry.get(user.label);
  if (last !== undefined && now - last < RETRY_MS) return;
  for (const [label, at] of lastRetry) if (now - at >= RETRY_MS) lastRetry.delete(label);
  lastRetry.set(user.label, now);
  after(() => createUserName(user.label, user.pass));
}

/** A path segment as the person wrote it: decoded once more if it still holds escapes. */
function decoded(segment: string): string {
  if (!segment.includes("%")) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Says whether a label is a person's name (the label is normalised first, see normalLabel), whether that name is on chain yet, and which seals the
 * person authorised, newest first (at most PASS_LIST_LIMIT), each with its event, picture and the
 * photo's own name (as the seal answer gives it), and the person's own address, which holds their
 * names on chain. The pass is not given. A name not on chain yet is asked for again (see retryName).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ label: string }> }) {
  const { label: given } = await params;
  const label = normalLabel(decoded(given));
  if (label === null) return Response.json({ state: "none" }, { status: 404, headers });
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
  const ens = await userEns(user.label);
  // A name that could not be created at register (say the tree was not set up yet) is asked for
  // again while the page polls; nothing is sent if the name is there by then.
  if (ens === "pending") retryName(user);
  return Response.json(
    {
      state: "listed",
      label: user.label,
      name: user.name,
      address: addressOf(user),
      ens: { state: ens },
      images,
    },
    { headers },
  );
}
