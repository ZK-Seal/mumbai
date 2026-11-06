import { createHash } from "node:crypto";
import {
  PICTURE_MAX_BYTES,
  PICTURE_MIN_BYTES,
  records,
  type PictureRecord,
  type SealRecord,
} from "@/lib/records";
import { pictureUrl, uploadPicture } from "@/lib/swarm";
import { isSealHash, pictureTokenMatches, worldConfig } from "@/lib/world";

// An upload to Swarm may take most of a minute.
export const maxDuration = 60;

const headers = { "cache-control": "no-store" };

function refused(reason: string, status: number) {
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
 * That this picture is the photo that was sealed is the uploader's word alone: the sealed file
 * stays private on the phone, so this server cannot compare the two. What it does keep is the
 * picture's SHA-256 and size, so the picture cannot be swapped for another one later.
 */
export async function POST(request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (!isSealHash(hash)) return refused("hash", 400);
  const config = worldConfig();
  if (!config) return refused("not-set-up", 503);
  if (!pictureTokenMatches(config, hash, request.headers.get("x-picture-token"))) {
    return refused("token", 403);
  }
  let record: SealRecord | null;
  let kept: PictureRecord | null;
  try {
    record = await records().get(hash);
    kept = record ? await records().getPicture(hash) : null;
  } catch {
    return refused("store", 503);
  }
  if (!record) return refused("unknown", 404);
  if (kept) return stored(kept);

  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "image/jpeg") return refused("not-jpeg", 415);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > PICTURE_MAX_BYTES) return refused("too-large", 413);
  const bytes = await readAtMost(request, PICTURE_MAX_BYTES);
  if (bytes === null) return refused("too-large", 413);
  if (bytes.length < PICTURE_MIN_BYTES) return refused("too-small", 400);
  if (!isJpeg(bytes)) return refused("not-jpeg", 415);

  let ref: string;
  try {
    ref = await uploadPicture(bytes, `${hash.slice(0, 16)}.jpg`);
  } catch {
    return refused("storage", 503);
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
    return refused("store", 503);
  }
  return stored(picture);
}
