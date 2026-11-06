import {
  byPerson,
  isEvent,
  records,
  withPictures,
  type EventSeal,
  type PictureRecord,
} from "@/lib/records";

/**
 * Says how many sealed photos were authorised at this event, and by how many people: one group
 * per pass, in the order each pass was first seen, with each photo's hash, time, and picture on
 * Swarm (or null when none was kept). The passes themselves are not given, as the pass list does
 * not give them.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!isEvent(event)) {
    return Response.json({ state: "refused", reason: "event" }, { status: 400 });
  }
  let seals: EventSeal[];
  let pictures: PictureRecord[];
  try {
    [seals, pictures] = await Promise.all([
      records().byEvent(event),
      records().picturesByEvent(event),
    ]);
  } catch {
    return Response.json({ state: "unknown", reason: "store" }, { status: 503 });
  }
  const groups = withPictures(byPerson(seals), pictures);
  return Response.json({
    state: "listed",
    event,
    photos: seals.length,
    people: groups.length,
    groups,
  });
}
