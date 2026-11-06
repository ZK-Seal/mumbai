import { connection } from "next/server";
import { deskName, ethClient } from "@/lib/ens";
import { listMembers } from "@/lib/desk";

/** The desk's current members, read from the chain: each name with its two records. */
export async function GET() {
  await connection();
  const headers = { "cache-control": "no-store" };
  const desk = deskName();
  if (!desk) return Response.json({ state: "desk-not-ready" }, { status: 503, headers });
  const members = await listMembers(ethClient(), desk);
  if (typeof members === "string") {
    return Response.json(
      { state: members },
      { status: members === "unreachable" ? 503 : 409, headers },
    );
  }
  return Response.json({ state: "listed", desk, members }, { headers });
}
