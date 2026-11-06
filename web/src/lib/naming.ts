import { registerUser, TreeError, userTaken } from "@/lib/tree";

/** Where a person's name stands on chain: asked for, or there. */
export type EnsState = "pending" | "done";

/** Whether the user's name is on chain yet. A chain that cannot be read says pending. */
export async function userEns(label: string): Promise<EnsState> {
  try {
    return (await userTaken(label)) ? "done" : "pending";
  } catch {
    return "pending";
  }
}

function why(error: unknown): string {
  return error instanceof TreeError ? error.reason : "chain";
}

/** Labels whose name is being created by this process, so one is never asked for twice at once. */
const creatingUsers = new Set<string>();

/**
 * Creates the user's name on chain, and says in one log line how it went. Meant to run after the
 * answer is sent: it takes from 15 seconds to a minute. Nothing is done while the same label is
 * already being created here.
 */
export async function createUserName(label: string, pass: string): Promise<void> {
  if (creatingUsers.has(label)) return;
  creatingUsers.add(label);
  try {
    const made = await registerUser(label, pass);
    console.info(`Names: created ${made.name} in ${made.tx}`);
  } catch (error) {
    console.warn(`Names: could not create the name for ${label}: ${why(error)}`);
  } finally {
    creatingUsers.delete(label);
  }
}
