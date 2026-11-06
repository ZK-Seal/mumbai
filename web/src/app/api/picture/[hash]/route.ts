import { createHash } from "node:crypto";
import { after } from "next/server";
import { createUserName, nameImage, userEns } from "@/lib/naming";
import {
  PICTURE_MAX_BYTES,
  PICTURE_MIN_BYTES,
  records,
  type PictureRecord,
  type SealRecord,
} from "@/lib/records";
import { pictureUrl, uploadPicture } from "@/lib/swarm";
import { isSealHash, pictureTokenMatches, worldConfig } from "@/lib/world";

// An upload to Swarm may take most of a minute, and after the answer the person's name (if it is
// still missing) and the photo's name are created, each given up to 50 s. 300 s is the most a
// function may run on the Hobby plan with fluid compute, which new projects have.
export const maxDuration = 300;

const headers = { "cache-control": "no-store" };

function refused(reason: string, status: number, hash: string) {
  console.log(`picture: refused ${reason} hash=${hash.slice(0, 8)}`);
  return Response.json({ state: "refused", reason }, { status, headers });
}

function stored(picture: PictureRecord) {
  return Response.json(
    { state: "stored", ref: picture.ref, url: pictureUrl(picture.ref) },
    { headers },
  );
}

/** A JPEG starts with FF D8 FF and ends with FF D9. */
function isJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return (
    n >= 5 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[n - 2] === 0xff &&
    bytes[n - 1] === 0xd9
  );
}

/** Reads the body, but no further than `limit` bytes. Null if it is longer, or cannot be read. */
async function readAtMost(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) {
        await reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/**
 * Keeps the picture of one authorised seal: the JPEG goes to Swarm as it is, unchanged, and a
 * pointer to it is kept next to the seal's record. Every answer is a word from a short fixed list.
 *
 * Only the client that just authorised the seal may upload, with the token the authorisation
 * answered with, in the `x-picture-token` header. Each seal keeps one picture, the first.
 *
 * Once the picture is kept, a seal at an event whose person has a user name gets a name of its
 * own on chain, image<N>.<event>.events.<root>, after the answer is sent. Posting again with the
 * token, once the picture is kept, tries the name again if it is still missing.
 *
 * That this picture is the photo that was sealed is the uploader's word alone: the sealed file
 * stays private on the phone, so this server cannot compare the two. What it does keep is the
 * picture's SHA-256 and size, so the picture cannot be swapped for another one later.
 */
export async function POST(request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!isSealHash(hash)) return refused("hash", 400, hash);
  const config = worldConfig();
  if (!config) return refused("not-set-up", 503, hash);
  if (!pictureTokenMatches(config, hash, request.headers.get("x-picture-token"))) {
    return refused("token", 403, hash);
  }
  let record: SealRecord | null;
  let kept: PictureRecord | null;
  try {
    record = await records().get(hash);
    kept = record ? await records().getPicture(hash) : null;
  } catch {
    return refused("store", 503, hash);
  }
  if (!record) return refused("unknown", 404, hash);
  if (kept) {
    // A picture whose photo has no name yet is named again, in case the first try failed.
    await nameLater(record, kept);
    return stored(kept);
  }

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "image/jpeg") return refused("not-jpeg", 415, hash);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > PICTURE_MAX_BYTES) return refused("too-large", 413, hash);
  const bytes = await readAtMost(request, PICTURE_MAX_BYTES);
  if (bytes === null) return refused("too-large", 413, hash);
  if (bytes.length < PICTURE_MIN_BYTES) return refused("too-small", 400, hash);
  if (!isJpeg(bytes)) return refused("not-jpeg", 415, hash);

  let ref: string;
  try {
    ref = await uploadPicture(bytes, `${hash.slice(0, 16)}.jpg`);
  } catch {
    return refused("storage", 503, hash);
  }
  let picture: PictureRecord;
  try {
    picture = await records().putPicture({
      hash,
      event: record.event,
      ref,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      at: new Date().toISOString(),
    });
  } catch {
    return refused("store", 503, hash);
  }
  console.log(`picture: stored hash=${hash.slice(0, 8)} ref=${ref.slice(0, 16)}`);
  await nameLater(record, picture);
  return stored(picture);
}

/**
 * Names the photo on chain after the answer is sent, when the seal is at an event, its person has
 * a user name, and the photo has no name yet. A store that cannot be read now is left for later,
 * and so is a name that cannot be created now: posting again tries it again.
 */
async function nameLater(record: SealRecord, picture: PictureRecord): Promise<void> {
  if (record.event === null) return;
  let user;
  try {
    const [found, named] = await Promise.all([
      records().userByPass(record.pass),
      records().getName(record.hash),
    ]);
    if (!found || named) return;
    user = found;
  } catch {
    return;
  }
  // A photo named before its person's name is on chain would fail, so that name is asked for
  // first: both writes wait their turn, so the photo's goes out once the person's has landed.
  after(async () => {
    if ((await userEns(user.label)) === "pending") await createUserName(user.label, user.pass);
    await nameImage(record, picture.ref);
  });
}
