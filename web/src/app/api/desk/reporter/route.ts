import { connection } from "next/server";
import { deskName, ethClient } from "@/lib/ens";
import { addReporter, adminWordMatches, botKey, removeReporter, type BotWord } from "@/lib/desk";

const STATUS: Record<BotWord, number> = {
  added: 200,
  removed: 200,
  label: 400,
  pass: 400,
  account: 400,
  taken: 409,
  "not-a-member": 404,
  "desk-not-ready": 409,
  "bot-unfunded": 402,
  unreachable: 503,
  failed: 502,
};

function answer(word: BotWord) {
  const done = word === "added" || word === "removed";
  return Response.json(done ? { state: word } : { state: "refused", reason: word }, {
    status: STATUS[word],
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Both ways in need the desk's admin word in the x-desk-word header, and a bot set up on this
 * server. Without either, everyone is refused.
 */
async function allowed(request: Request): Promise<Response | null> {
  await connection();
  const headers = { "cache-control": "no-store" };
  if (!botKey() || !process.env.DESK_ADMIN_WORD || !deskName()) {
    return Response.json({ state: "refused", reason: "not-set-up" }, { status: 503, headers });
  }
  if (!adminWordMatches(request.headers.get("x-desk-word"))) {
    return Response.json({ state: "refused", reason: "word" }, { status: 401, headers });
  }
  return null;
}

/** Adds a reporter: { label, pass, account? }. The bot writes the records, then the name. */
export async function POST(request: Request) {
  const refused = await allowed(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  return answer(await addReporter(ethClient(), deskName() as string, body ?? {}));
}

/** Removes a reporter: { label }. The name leaves the member list, and its records stop resolving. */
export async function DELETE(request: Request) {
  const refused = await allowed(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  return answer(await removeReporter(ethClient(), deskName() as string, body ?? {}));
}
