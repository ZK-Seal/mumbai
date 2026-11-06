import { connection } from "next/server";
import { deskName } from "@/lib/ens";
import { botAddress, deskChainId } from "@/lib/desk";

/** What the desk's page needs to know about this server: the desk, its bot's address, the chain. */
export async function GET() {
  await connection();
  return Response.json(
    { desk: deskName(), bot: botAddress(), chainId: deskChainId() },
    { headers: { "cache-control": "no-store" } },
  );
}
