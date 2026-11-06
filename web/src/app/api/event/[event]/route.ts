import { eventPhotos, isEvent } from "@/lib/records";

/**
 * Says how many sealed photos were authorised at this event, and by how many people: one group
 * per pass, in the order each pass was first seen, under the person's user name and address (or
 * null), with each photo's hash, time, picture on Swarm (or null when none was kept), the person's
 * name again, and the photo's own name: `{name, state: "done"}`, `{state: "pending"}` while it is
 * being created, or null when it will not get one. The passes themselves are not given, as the
 * pass list does not give them. `people` counts the groups: a named person once, by their join
 * pass, and each photo authorised without a session as a person of its own.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ event: string }> }) {
  const { event } = await params;
  if (!isEvent(event)) {
    return Response.json({ state: "refused", reason: "event" }, { status: 400 });
  }
  let listed: Awaited<ReturnType<typeof eventPhotos>>;
  try {
    listed = await eventPhotos(event);
  } catch {
    return Response.json({ state: "unknown", reason: "store" }, { status: 503 });
  }
  const { seals, groups } = listed;
  return Response.json({
    state: "listed",
    event,
    photos: seals.length,
    people: groups.length,
    groups,
  });
}
