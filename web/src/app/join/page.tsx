import { Suspense } from "react";
import { appReturnBase } from "@/lib/app-return";
import { normalLabel } from "@/lib/records";
import { treeRoot } from "@/lib/tree";
import { Join } from "./join";

type Query = Record<string, string | string[] | undefined>;

async function JoinPart({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const root = treeRoot();
  if (!root) {
    return (
      <p className="state" role="status">
        Names are not set up on this server yet.
      </p>
    );
  }
  // The app adds from=app when it opens this page in its browser sheet; nothing else counts.
  const fromApp = query.from === "app";
  return (
    <Join
      root={root}
      label={normalLabel(query.label) ?? ""}
      toApp={fromApp ? appReturnBase() : null}
    />
  );
}

export default function JoinPage({ searchParams }: { searchParams: Promise<Query> }) {
  return (
    <main>
      <h1>Take a name</h1>
      <p className="soft">
        A verified person can take one name of their own. The photos they authorise from then on are
        shown under it, and each one gets a name of its own.
      </p>
      <Suspense fallback={<p className="soft">Reading the link…</p>}>
        <JoinPart searchParams={searchParams} />
      </Suspense>
      <footer className="notes">
        <p>One person keeps one name, and one name belongs to one person.</p>
        <p>The name says a verified human holds it. It does not say who they are.</p>
      </footer>
    </main>
  );
}
