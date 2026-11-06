import { connection } from "next/server";
import { deskName, ethClient } from "@/lib/ens";
import { botAddress } from "@/lib/desk";
import { planToJson, readSetup } from "@/lib/desk-setup";

/** Reads each step of the desk's setup from the chain, with what the steps are built from. */
export async function GET() {
  await connection();
  const headers = { "cache-control": "no-store" };
  const desk = deskName();
  if (!desk) return Response.json({ state: "not-a-desk" }, { status: 503, headers });
  const setup = await readSetup(ethClient(), desk, botAddress());
  if (typeof setup === "string") {
    return Response.json(
      { state: setup },
      { status: setup === "unreachable" ? 503 : 404, headers },
    );
  }
  return Response.json(
    { state: "read", plan: planToJson(setup.plan), steps: setup.steps },
    { headers },
  );
}
