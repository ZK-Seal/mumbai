import { connection } from "next/server";
import { deskName, ethClient } from "@/lib/ens";
import { buildSite, readRef, readSite, type Site, type SiteTx } from "@/lib/site";

const headers = { "cache-control": "no-store" };

function siteToJson(site: Site) {
  return { state: "read", ...site, contenthash: site.contenthash ?? "none" };
}

function txToJson(tx: SiteTx) {
  return { to: tx.to, data: tx.data, value: tx.value.toString(), title: tx.title };
}

async function read(): Promise<Site | Response> {
  const root = deskName();
  if (!root) return Response.json({ state: "not-a-desk" }, { status: 503, headers });
  try {
    const site = await readSite(ethClient(), root);
    if (!site) return Response.json({ state: "not-a-desk" }, { status: 404, headers });
    return site;
  } catch {
    return Response.json({ state: "unreachable" }, { status: 503, headers });
  }
}

/** The root's site as the chain serves it: its resolver, contenthash, url, and who may set them. */
export async function GET() {
  await connection();
  const site = await read();
  if (site instanceof Response) return site;
  return Response.json(siteToJson(site), { headers });
}

/** The holder's transaction(s) that point the root at the Swarm page { ref }. Nothing is sent. */
export async function POST(request: Request) {
  await connection();
  const body = (await request.json().catch(() => null)) as { ref?: unknown } | null;
  const ref = readRef(body?.ref);
  if (!ref) return Response.json({ state: "refused", reason: "ref" }, { status: 400, headers });
  const site = await read();
  if (site instanceof Response) return site;
  if (!site.holderMaySet) {
    return Response.json({ state: "refused", reason: "holder-may-not-set" }, { status: 409, headers });
  }
  const txs = buildSite({ root: site.root, resolver: site.resolver, ref, multicall: site.multicall });
  return Response.json(
    { state: "ready", holder: site.holder, ref, txs: txs.map(txToJson) },
    { headers },
  );
}
