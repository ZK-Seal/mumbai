import { connection } from "next/server";
import { adminWordMatches } from "@/lib/desk";
import { setupTree } from "@/lib/tree-setup";
import { treeRoot, treeSigner, TreeError, type TreeReason } from "@/lib/tree";

export const maxDuration = 60;

const STATUS: Record<TreeReason, number> = {
  "not-set-up": 409,
  taken: 409,
  funds: 402,
  chain: 502,
};

/**
 * Builds whatever of the tree is still missing, from the bot, and answers with the status after.
 * Needs the desk's admin word in the x-desk-word header; without DESK_ADMIN_WORD everyone is
 * refused.
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
  try {
    const status = await setupTree();
    return Response.json({ state: "done", status }, { headers });
  } catch (error) {
    const reason = error instanceof TreeError ? error.reason : "chain";
    return Response.json({ state: "refused", reason }, { status: STATUS[reason], headers });
  }
}
