import { connection } from "next/server";
import { normalName } from "@/lib/ens";
import { treeStatus } from "@/lib/tree-setup";
import { readTreeName, treeRoot } from "@/lib/tree";

/**
 * Which pieces of the tree exist, read from the chain, with the bot's balance and what the rest
 * would cost. With ?name=, reads that one tree name instead, the way anyone else would: through
 * the Universal Resolver.
 */
export async function GET(request: Request) {
  await connection();
  const headers = { "cache-control": "no-store" };
  const asked = new URL(request.url).searchParams.get("name");
  if (asked !== null) {
    const name = normalName(asked);
    const root = treeRoot();
    const inTree =
      name !== null &&
      root !== null &&
      (name.endsWith(`.users.${root}`) || name.endsWith(`.events.${root}`));
    if (!inTree) return Response.json({ state: "not-in-tree" }, { status: 404, headers });
    try {
      return Response.json({ state: "read", reading: await readTreeName(name) }, { headers });
    } catch {
      return Response.json({ state: "unreachable" }, { status: 503, headers });
    }
  }
  const status = await treeStatus();
  return Response.json(status, { status: status.state === "unreachable" ? 503 : 200, headers });
}
