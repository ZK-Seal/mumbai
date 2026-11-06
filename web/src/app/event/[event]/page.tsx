import { Suspense } from "react";
import { connection } from "next/server";
import { byPerson, isEvent, records, type EventSeal } from "@/lib/records";

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

async function EventPart({ params }: { params: Promise<{ event: string }> }) {
  await connection();
  const { event } = await params;
  if (!isEvent(event)) {
    return <p className="state bad">This link does not name an event.</p>;
  }
  let seals: EventSeal[];
  try {
    seals = await records().byEvent(event);
  } catch {
    return <p className="state bad">The record of seals cannot be read just now. Try again later.</p>;
  }
  const groups = byPerson(seals);
  return (
    <>
      <dl className="seal">
        <dt>Event</dt>
        <dd className="mono">{event}</dd>
      </dl>
      {groups.length === 0 ? (
        <p className="state">No sealed photo was authorised at this event yet.</p>
      ) : (
        <>
          <p className="state good" role="status">
            {count(seals.length, "sealed photo", "sealed photos")} from{" "}
            {count(groups.length, "verified person", "verified people")}
          </p>
          {groups.map((group, i) => (
            <section className="others" key={group.photos[0].hash}>
              <h2>
                Person {i + 1} — {count(group.photos.length, "photo", "photos")}
              </h2>
              <ol>
                {group.photos.map((photo) => (
                  <li key={photo.hash}>
                    <a className="mono" href={`/api/seal/${photo.hash}`} title={photo.hash}>
                      {shortHash(photo.hash)}
                    </a>
                    <time className="soft" dateTime={photo.at}>
                      {new Date(photo.at).toISOString().slice(0, 16).replace("T", " ")} UTC
                    </time>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </>
      )}
    </>
  );
}

export default function EventPage({ params }: { params: Promise<{ event: string }> }) {
  return (
    <main>
      <h1>Sealed photos at one event</h1>
      <p className="soft">
        Each sealed photo here was authorised by a verified person. Photos authorised by the same
        person are counted under one person, however many cameras took them.
      </p>
      <Suspense fallback={<p className="soft">Reading the record of seals…</p>}>
        <EventPart params={params} />
      </Suspense>
      <footer className="notes">
        <p>A person is known here only by their pass, which is not shown.</p>
        <p>This page says how many people stand behind the photos. It does not say who they are.</p>
      </footer>
    </main>
  );
}
