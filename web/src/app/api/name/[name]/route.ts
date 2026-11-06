import { deskName, ethClient, readName } from "@/lib/ens";

/**
 * Says where a name stands with this server's desk: a member or not, and the pass and account
 * records stored on it. Read from the chain each time; nothing here is kept.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const headers = { "cache-control": "no-store" };
  const desk = deskName();
  if (!desk) return Response.json({ state: "no-desk-registry" }, { status: 503, headers });
  const reading = await readName(ethClient(), desk, name);
  const status = reading.state === "unreachable" ? 503 : reading.name === null ? 400 : 200;
  return Response.json(reading, { status, headers });
}
