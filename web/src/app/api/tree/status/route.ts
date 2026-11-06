import { connection } from "next/server";
import { normalName } from "@/lib/ens";
import { treeStatus } from "@/lib/tree-setup";
import { isAddress } from "viem";
import { primaryName, readTreeName, treeRoot } from "@/lib/tree";

/**
 * Which pieces of the tree exist, read from the chain, with the bot's balance and what the rest
 * would cost. With ?name=, reads that one tree name instead, the way anyone else would: through
 * the Universal Resolver, with the primary name of the address it points to. With ?address=,
 * reads that address's primary name.
 */
export async function GET(request: Request) {
  await connection();
  const headers = { "cache-control": "no-store" };
  const params = new URL(request.url).searchParams;
  const address = params.get("address");
  if (address !== null) {
    if (!isAddress(address)) return Response.json({ state: "not-an-address" }, { status: 400, headers });
    return Response.json({ state: "read", address, primaryName: await primaryName(address) }, { headers });
  }
  const asked = params.get("name");
  if (asked !== null) {
    const name = normalName(asked);
    const root = treeRoot();
    const inTree =
      name !== null &&
      root !== null &&
      (name.endsWith(`.users.${root}`) || name.endsWith(`.events.${root}`));
    if (!inTree) return Response.json({ state: "not-in-tree" }, { status: 404, headers });
    try {
      const reading = await readTreeName(name);
      const primary = reading.address ? await primaryName(reading.address) : null;
      return Response.json({ state: "read", reading, primaryName: primary }, { headers });
    } catch {
      return Response.json({ state: "unreachable" }, { status: 503, headers });
    }
  }
  const status = await treeStatus();
  return Response.json(status, { status: status.state === "unreachable" ? 503 : 200, headers });
}
