import { connection, type NextRequest } from "next/server";
import { accountName, readSession, SESSION_COOKIE, signinConfig, standing } from "@/lib/signin";

/** Says whether someone is signed in. Only a short name for the account, never its subject. */
export async function GET(request: NextRequest) {
  await connection();
  const headers = { "cache-control": "no-store" };
  const config = signinConfig();
  if (!config) return Response.json({ state: "not-set-up" }, { headers });
  const session = await readSession(config, request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return Response.json({ state: "out" }, { headers });
  const now = standing(config, session);
  return Response.json(
    {
      state: "in",
      fresh: now === "fresh",
      verified: session.acr === config.acr,
      account: accountName(session),
    },
    { headers },
  );
}
