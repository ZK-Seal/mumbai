import { signRequest } from "@worldcoin/idkit/signing";
import { hashSignal } from "@worldcoin/idkit/hashing";

export type Credential = "human" | "selfie";
export type Environment = "production" | "staging" | "sandbox";

export type WorldConfig = {
  appId: `app_${string}`;
  rpId: string;
  signingKey: string;
  action: string;
  environment: Environment;
  credential: Credential;
};

/** Reads the World settings from the environment. Null if any required one is missing. */
export function worldConfig(): WorldConfig | null {
  const appId = process.env.WORLD_APP_ID ?? "";
  const rpId = process.env.WORLD_RP_ID ?? "";
  const signingKey = process.env.WORLD_SIGNING_KEY ?? "";
  if (!appId.startsWith("app_") || !rpId.startsWith("rp_") || signingKey === "") {
    return null;
  }
  const environment = process.env.WORLD_ENVIRONMENT;
  return {
    appId: appId as `app_${string}`,
    rpId,
    signingKey,
    action: process.env.WORLD_ACTION || "authorise-seal",
    environment:
      environment === "production" || environment === "sandbox" ? environment : "staging",
    credential: process.env.WORLD_CREDENTIAL === "selfie" ? "selfie" : "human",
  };
}

/** A sealed file is named by its SHA-256, as 64 lowercase hex characters. */
export function isSealHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * The World action for one request: one action per event, so a proof made for one event cannot
 * stand for another, or for none. With no event it is the plain WORLD_ACTION.
 */
export function actionFor(config: WorldConfig, event: string | null): string {
  return event === null ? config.action : `${config.action}-${event}`;
}

/** The signed context the World app needs before it makes a proof. Valid for five minutes. */
export function requestContext(config: WorldConfig, action: string) {
  const signed = signRequest({ signingKeyHex: config.signingKey, action, ttl: 300 });
  return {
    rp_id: config.rpId,
    nonce: signed.nonce,
    created_at: signed.createdAt,
    expires_at: signed.expiresAt,
    signature: signed.sig,
  };
}

/** The value a proof must carry to belong to this seal and no other. */
export function sealSignal(hash: string): string {
  return hashSignal(hash).toLowerCase();
}

type ResponseItem = { identifier?: unknown; signal_hash?: unknown; nullifier?: unknown };

/**
 * Picks the one answer we asked for out of a proof result, and checks it is tied to this seal
 * and made for this action. World checks the proof against the action and signal the result
 * names, so both must be ours. Returns its nullifier, or null if the result is not what was asked.
 */
export function boundNullifier(
  result: unknown,
  hash: string,
  config: WorldConfig,
  action: string,
): string | null {
  if ((result as { action?: unknown })?.action !== action) return null;
  const responses = (result as { responses?: unknown })?.responses;
  if (!Array.isArray(responses) || responses.length !== 1) return null;
  const item = responses[0] as ResponseItem;
  if (typeof item.signal_hash !== "string" || typeof item.nullifier !== "string") return null;
  if (item.signal_hash.toLowerCase() !== sealSignal(hash)) return null;
  const wanted = config.credential === "selfie" ? ["selfie"] : ["proof_of_human", "orb"];
  if (typeof item.identifier !== "string" || !wanted.includes(item.identifier)) return null;
  return item.nullifier;
}

/**
 * Asks World whether the proof is good. True only for a clear yes in the environment we expect,
 * and, when World names the action it checked, for this action.
 */
export async function worldAccepts(
  result: unknown,
  config: WorldConfig,
  action: string,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`https://developer.world.org/api/v4/verify/${config.rpId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const answer = (await response.json().catch(() => null)) as
    | { success?: unknown; environment?: unknown; action?: unknown }
    | null;
  if (answer?.action !== undefined && answer.action !== action) return false;
  return answer?.success === true && answer.environment === config.environment;
}
