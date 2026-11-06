import { byPerson, isEvent, records, type EventSeal } from "@/lib/records";

/**
 * Says how many sealed photos were authorised at this event, and by how many people: one group
 * per pass, in the order each pass was first seen, with each photo's hash and time. The passes
 * themselves are not given, as the pass list does not give them.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!isEvent(event)) {
    return Response.json({ state: "refused", reason: "event" }, { status: 400 });
  }
  let seals: EventSeal[];
  try {
    seals = await records().byEvent(event);
  } catch {
    return Response.json({ state: "unknown", reason: "store" }, { status: 503 });
  }
  const groups = byPerson(seals);
  return Response.json({
    state: "listed",
    event,
    photos: seals.length,
    people: groups.length,
    groups,
  });
}
