import { connection } from "next/server";
import { adminWordMatches } from "@/lib/desk";
import { isEvent } from "@/lib/records";
import { isSwarmRef } from "@/lib/swarm";
import { setEventPage, treeRoot, treeSigner, TreeError, type TreeReason } from "@/lib/tree";

// One wave, or two for an event that is new: up to two blocks, with time to spare.
export const maxDuration = 60;

const STATUS: Record<TreeReason, number> = {
  "not-set-up": 409,
  taken: 409,
  funds: 402,
  chain: 502,
};

/**
 * Points an event's name, <event>.events.<root>, at its gallery page: `ref` the page on Swarm (its
 * contenthash) and `url` a plain link to it. Needs the desk's admin word in the x-desk-word
 * header; without DESK_ADMIN_WORD everyone is refused. The same page again sends nothing.
 */
export async function POST(request: Request) {
  await connection();
  const headers = { "cache-control": "no-store" };
  if (!treeSigner() || !process.env.DESK_ADMIN_WORD || !treeRoot()) {
    return Response.json({ state: "refused", reason: "not-set-up" }, { status: 503, headers });
  }
  if (!adminWordMatches(request.headers.get("x-desk-word"))) {
    return Response.json({ state: "refused", reason: "word" }, { status: 401, headers });
  }
  const body = (await request.json().catch(() => null)) as
    | { event?: unknown; ref?: unknown; url?: unknown }
    | null;
  if (!isEvent(body?.event)) {
    return Response.json({ state: "refused", reason: "event" }, { status: 400, headers });
  }
  if (!isSwarmRef(body.ref)) {
    return Response.json({ state: "refused", reason: "ref" }, { status: 400, headers });
  }
  const url = body.url;
  if (typeof url !== "string" || !/^https?:\/\/\S+$/.test(url) || url.length > 2048) {
    return Response.json({ state: "refused", reason: "url" }, { status: 400, headers });
  }
  try {
    const page = await setEventPage(body.event, body.ref, url);
    return Response.json({ state: "done", name: page.name, tx: page.tx }, { headers });
  } catch (error) {
    const reason = error instanceof TreeError ? error.reason : "chain";
    return Response.json({ state: "refused", reason }, { status: STATUS[reason], headers });
  }
}
