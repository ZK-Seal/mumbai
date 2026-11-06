import { Suspense } from "react";
import { connection } from "next/server";
import { eventPhotos, isEvent, type EventPhoto } from "@/lib/records";

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function when(at: string): string {
  return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** One photo with its picture: the picture in a fixed box, the shortened hash underneath. */
function Picture({ photo, url }: { photo: EventPhoto; url: string }) {
  return (
    <li>
      <figure>
        <a className="frame" href={url}>
          {/* eslint-disable-next-line @next/next/no-img-element -- served as is from Swarm */}
          <img src={url} alt="Sealed photo" loading="lazy" decoding="async" />
        </a>
        <figcaption>
          <a className="mono" href={`/api/seal/${photo.hash}`} title={photo.hash}>
            {shortHash(photo.hash)}
          </a>
          <time className="soft" dateTime={photo.at}>
            {when(photo.at)}
          </time>
          {photo.image?.state === "done" && <span className="mono">{photo.image.name}</span>}
        </figcaption>
      </figure>
    </li>
  );
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
  let listed: Awaited<ReturnType<typeof eventPhotos>>;
  try {
    listed = await eventPhotos(event);
  } catch {
    return <p className="state bad">The record of seals cannot be read just now. Try again later.</p>;
  }
  const { seals, groups } = listed;
  // Once anyone here has a name, a person without one is shown as such, not by a number.
  const anyNamed = groups.some((group) => group.name !== null);
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
                {group.name ?? (anyNamed ? "No name" : `Person ${i + 1}`)} —{" "}
                {count(group.photos.length, "photo", "photos")}
              </h2>
              {group.photos.some((photo) => photo.picture) && (
                <ol className="pictures">
                  {group.photos.map((photo) =>
                    photo.picture ? (
                      <Picture key={photo.hash} photo={photo} url={photo.picture.url} />
                    ) : null,
                  )}
                </ol>
              )}
              {group.photos.some((photo) => !photo.picture) && (
                <ol>
                  {group.photos
                    .filter((photo) => !photo.picture)
                    .map((photo) => (
                      <li key={photo.hash}>
                        <a className="mono" href={`/api/seal/${photo.hash}`} title={photo.hash}>
                          {shortHash(photo.hash)}
                        </a>
                        <time className="soft" dateTime={photo.at}>
                          {when(photo.at)}
                        </time>
                      </li>
                    ))}
                </ol>
              )}
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
        <p>
          A person is known here only by their pass, which is not shown, or by the name they took
          with it.
        </p>
        <p>This page says how many people stand behind the photos. It does not say who they are.</p>
        <p>
          A picture is kept on Swarm as the person&rsquo;s phone sent it. That it is the photo
          that was sealed is their word; it is not checked against the seal.
        </p>
      </footer>
    </main>
  );
}
