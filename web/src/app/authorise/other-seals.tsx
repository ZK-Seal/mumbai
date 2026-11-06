"use client";

import { useEffect, useState } from "react";

type Seal = { hash: string; at: string };

type List = { name: "reading" } | { name: "listed"; seals: Seal[] } | { name: "unknown" };

/** Takes the server's list apart. Null unless every entry is a seal hash and a time. */
function readList(answer: unknown): Seal[] | null {
  const a = answer as { state?: unknown; seals?: unknown } | null;
  if (a?.state !== "listed" || !Array.isArray(a.seals)) return null;
  const seals: Seal[] = [];
  for (const item of a.seals as { hash?: unknown; at?: unknown }[]) {
    if (typeof item?.hash !== "string" || !/^[0-9a-f]{64}$/.test(item.hash)) return null;
    if (typeof item.at !== "string" || Number.isNaN(Date.parse(item.at))) return null;
    seals.push({ hash: item.hash, at: item.at });
  }
  return seals;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function when(at: string): string {
  return new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The other seals the same pass authorised, newest first, read from the record of seals. */
export function OtherSeals({ pass, hash }: { pass: string; hash: string }) {
  const [list, setList] = useState<List>({ name: "reading" });

  useEffect(() => {
    let live = true;
    fetch(`/api/pass/${encodeURIComponent(pass)}`)
      .then((response) => response.json())
      .catch(() => null)
      .then((answer) => {
        if (!live) return;
        const seals = readList(answer);
        setList(seals ? { name: "listed", seals } : { name: "unknown" });
      });
    return () => {
      live = false;
    };
  }, [pass]);

  const others = list.name === "listed" ? list.seals.filter((seal) => seal.hash !== hash) : [];

  return (
    <section className="others" aria-live="polite">
      <h2>Other seals authorised with this pass</h2>
      {list.name === "reading" ? (
        <p className="soft">Reading the record of seals…</p>
      ) : list.name === "unknown" ? (
        <p className="soft">The other seals cannot be read just now.</p>
      ) : others.length === 0 ? (
        <p className="soft">No other seal was authorised with this pass.</p>
      ) : (
        <ol>
          {others.map((seal) => (
            <li key={seal.hash}>
              <span className="mono" title={seal.hash}>
                {shortHash(seal.hash)}
              </span>
              <time className="soft" dateTime={seal.at}>
                {when(seal.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
