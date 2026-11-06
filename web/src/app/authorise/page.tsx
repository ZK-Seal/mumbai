import { Suspense } from "react";
import { deskName } from "@/lib/ens";
import { isEvent, records, type SealRecord } from "@/lib/records";
import { gate } from "@/lib/signin";
import { isSealHash } from "@/lib/world";
import { Authorise, type Edit, type SigninNow, type SigninWord } from "./authorise";

type Query = Record<string, string | string[] | undefined>;

type Seal = { hash: string; edit: Edit; width: number; height: number; event: string | null };

/** A side of the photo in pixels: a whole number from 1 to 99999, written plainly. */
function side(value: string | string[] | undefined): number | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value)) return null;
  return Number(value);
}

/** Reads the link the app opened. Null unless every part is exactly what the app sends. */
function readSeal(query: Query): Seal | null {
  const { hash, edit, w, h, event } = query;
  if (!isSealHash(hash)) return null;
  if (edit !== "blank" && edit !== "blur") return null;
  const width = side(w);
  const height = side(h);
  if (width === null || height === null) return null;
  if (event !== undefined && !isEvent(event)) return null;
  return { hash, edit, width, height, event: event ?? null };
}

const WORDS: SigninWord[] = ["denied", "expired", "failed", "class"];

/** The word a sign-in came back with, if it is one of ours. */
function readWord(value: string | string[] | undefined): SigninWord | null {
  return WORDS.find((word) => word === value) ?? null;
}

async function SealPart({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const seal = readSeal(query);
  if (!seal) {
    return <p className="state bad">This link does not name a seal.</p>;
  }
  let kept: SealRecord | null;
  try {
    kept = await records().get(seal.hash);
  } catch {
    return <p className="state bad">The record of seals cannot be read just now. Try again later.</p>;
  }
  const now = await gate();
  const signin: SigninNow = !now.setUp
    ? { standing: "not-set-up", account: null }
    : now.standing === "out"
      ? { standing: "out", account: null }
      : { standing: now.standing, account: now.account };
  return (
    <Authorise
      hash={seal.hash}
      edit={seal.edit}
      width={seal.width}
      height={seal.height}
      event={kept ? kept.event : seal.event}
      pass={kept?.pass ?? null}
      member={kept?.name ?? null}
      desk={deskName()}
      signin={signin}
      word={readWord(query.signin)}
    />
  );
}

export default function AuthorisePage({ searchParams }: { searchParams: Promise<Query> }) {
  return (
    <main>
      <h1>Authorise a seal</h1>
      <p className="soft">
        A photo was edited and sealed in the app. A person can now stand behind that one seal.
      </p>
      <Suspense fallback={<p className="soft">Reading the link…</p>}>
        <SealPart searchParams={searchParams} />
      </Suspense>
      <footer className="notes">
        <p>The seal itself was checked by our server, not by this page.</p>
        <p>This line says a person approved the seal. It does not say who took the photo.</p>
      </footer>
    </main>
  );
}
