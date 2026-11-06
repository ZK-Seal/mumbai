import { createHmac, timingSafeEqual } from "node:crypto";
import { signRequest } from "@worldcoin/idkit/signing";
import { hashSignal } from "@worldcoin/idkit/hashing";

export type Credential = "human" | "selfie";
export type Environment = "production" | "staging" | "sandbox";

export type WorldConfig = {
  appId: `app_${string}`;
  rpId: string;
  signingKey: string;
  /** The action photos are authorised with, or the stem of each photo's own action. */
  action: string;
  /** The action a person gives their user name with (WORLD_JOIN_ACTION, default `join`). */
  joinAction: string;
  /**
   * `per-photo` (the default): each photo has an action of its own, drawn from its hash. `one`:
   * every photo shares `action`. WORLD_PHOTO_ACTIONS sets it.
   */
  photoActions: "per-photo" | "one";
  /**
   * Whether each event gets an action of its own (WORLD_EVENT_ACTIONS=on). Off by default, and
   * only heeded with WORLD_PHOTO_ACTIONS=one: a per-photo action is already one of a kind.
   */
  eventActions: boolean;
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
    joinAction: process.env.WORLD_JOIN_ACTION || "join",
    photoActions: process.env.WORLD_PHOTO_ACTIONS === "one" ? "one" : "per-photo",
    eventActions: process.env.WORLD_EVENT_ACTIONS === "on",
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
 * The World action a photo is authorised with. The World app makes one proof per person and
 * action, and refuses a second (`nullifier_replayed`), so a person who has given a proof for an
 * action can never give another for it. Hence the join step has an action of its own
 * (`joinAction`), and by default each photo too: `<action>-<first 16 hex of its hash>`. The
 * request and verify routes both call this, so they always agree on it.
 *
 * With WORLD_PHOTO_ACTIONS=one every photo shares `action`, as before: then a person can
 * authorise one photo only. WORLD_EVENT_ACTIONS=on gives each event an action of its own in that
 * mode, and is ignored in per-photo mode.
 */
export function actionFor(config: WorldConfig, hash: string, event: string | null): string {
  if (config.photoActions === "per-photo") return `${config.action}-${hash.slice(0, 16)}`;
  return event === null || !config.eventActions ? config.action : `${config.action}-${event}`;
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

/**
 * The value a proof must carry to belong to one thing and no other: a seal's hash, or
 * `user:<label>` for a user name.
 */
export function sealSignal(signal: string): string {
  return hashSignal(signal).toLowerCase();
}

/** A value for a log line, cut to 20 characters. */
function clip(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return text.length > 20 ? `${text.slice(0, 20)}...` : text;
}

function unbound(why: string): null {
  console.log(`world: not bound: ${why}`);
  return null;
}

type ResponseItem = { identifier?: unknown; signal_hash?: unknown; nullifier?: unknown };

/**
 * Picks the one answer we asked for out of a proof result, and checks it is tied to this signal
 * (a seal's hash, or `user:<label>`) and made for this action. World checks the proof against
 * the action and signal the result names, so both must be ours. Returns its nullifier, or null
 * if the result is not what was asked.
 */
export function boundNullifier(
  result: unknown,
  signal: string,
  config: WorldConfig,
  action: string,
): string | null {
  const given = (result as { action?: unknown })?.action;
  if (given !== action) return unbound(`action mismatch ${clip(given)} wanted ${action}`);
  const responses = (result as { responses?: unknown })?.responses;
  if (!Array.isArray(responses) || responses.length !== 1) {
    const count = Array.isArray(responses) ? responses.length : clip(responses);
    return unbound(`responses count ${count}`);
  }
  const item = responses[0] as ResponseItem;
  if (typeof item.signal_hash !== "string") return unbound(`signal ${clip(item.signal_hash)}`);
  if (typeof item.nullifier !== "string") return unbound(`nullifier ${clip(item.nullifier)}`);
  if (item.signal_hash.toLowerCase() !== sealSignal(signal)) {
    const want = clip(sealSignal(signal));
    return unbound(`signal mismatch ${clip(item.signal_hash)} wanted ${want}`);
  }
  const wanted = config.credential === "selfie" ? ["selfie"] : ["proof_of_human", "orb"];
  if (typeof item.identifier !== "string" || !wanted.includes(item.identifier)) {
    return unbound(`identifier ${clip(item.identifier)} wanted ${wanted.join("|")}`);
  }
  return item.nullifier;
}

/** What World says when it refuses, as far as it says anything. */
type WorldError = { code?: unknown; detail?: unknown; message?: unknown };

/**
 * Asks World whether the proof is good. True only for a clear yes in the environment we expect,
 * and, when World names the action it checked, for this action. A result made for another
 * environment (a staging or sandbox proof on a production server, or the other way round) is
 * refused before World is asked.
 */
export async function worldAccepts(
  result: unknown,
  config: WorldConfig,
  action: string,
): Promise<boolean> {
  const given = (result as { environment?: unknown })?.environment;
  if (given !== config.environment) {
    const want = config.environment;
    console.log(`world: not bound: environment mismatch ${clip(given)} wanted ${want}`);
    return false;
  }
  const where = `action=${action} env=${config.environment}`;
  let response: Response;
  try {
    response = await fetch(`https://developer.world.org/api/v4/verify/${config.rpId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.log(`world: verify unreachable ${clip((error as Error)?.name ?? error)} ${where}`);
    return false;
  }
  const answer = (await response.json().catch(() => null)) as
    | ({ success?: unknown; environment?: unknown; action?: unknown } & WorldError)
    | null;
  /** One line with World's own code and message, if it gave any, else what we found wrong. */
  const refuse = (why: string) => {
    const said = [answer?.code, answer?.detail ?? answer?.message]
      .filter((part) => part !== undefined && part !== null)
      .map((part) => (typeof part === "string" ? part : JSON.stringify(part)).slice(0, 120))
      .join(" ");
    console.log(`world: verify refused ${response.status} ${said || why} ${where}`);
    return false;
  };
  if (!response.ok) return refuse("not-ok");
  if (answer?.action !== undefined && answer.action !== action) {
    return refuse(`action ${clip(answer.action)}`);
  }
  if (answer?.success !== true) return refuse("success=false");
  if (answer.environment !== config.environment) {
    return refuse(`environment ${clip(answer.environment)}`);
  }
  return true;
}

/**
 * The signal of a proof given for a user name. Its prefix keeps it apart from every seal hash.
 */
export function userSignal(label: string): string {
  return `user:${label}`;
}

/**
 * The token that lets a client upload the picture of one seal: HMAC-SHA256 over "picture:" and
 * the hash, as hex. Its key is drawn from the signing key under a fixed label, so the signing key
 * itself never leaves the server and no other secret is needed. Only the answer that keeps a new
 * record carries it, so only the client that just authorised the seal holds it.
 */
export function pictureToken(config: WorldConfig, hash: string): string {
  const key = createHmac("sha256", config.signingKey).update("picture-token-key").digest();
  return createHmac("sha256", key).update(`picture:${hash}`).digest("hex");
}

/** Whether a token given with an upload is the one for this seal, compared in constant time. */
export function pictureTokenMatches(config: WorldConfig, hash: string, given: string | null) {
  if (given === null || !/^[0-9a-f]{64}$/.test(given)) return false;
  return timingSafeEqual(Buffer.from(pictureToken(config, hash), "hex"), Buffer.from(given, "hex"));
}

/** The key sessions are signed with, drawn from the signing key under a fixed label. */
function sessionKey(config: WorldConfig): Buffer {
  return createHmac("sha256", config.signingKey).update("session-key").digest();
}

function sessionMac(config: WorldConfig, pass: string): string {
  return createHmac("sha256", sessionKey(config)).update(`session:${pass}`).digest("hex");
}

/**
 * The session a person is given with their user name: `<pass>.<hex HMAC-SHA256 over "session:"
 * and the pass>`. With per-photo actions a photo's proof has a nullifier of its own, never the
 * person's pass, so this session, given back with each photo, is what ties a photo to its named
 * person. That link is our server's word; each photo still carries its own World proof of a
 * unique human. Only the answer to a register call carries it; no other answer gives it.
 */
export function sessionFor(config: WorldConfig, pass: string): string {
  return `${pass}.${sessionMac(config, pass)}`;
}

/** The pass a session given with a photo holds, or null if it is not one of ours. */
export function sessionPass(config: WorldConfig, given: unknown): string | null {
  if (typeof given !== "string" || given.length > 300) return null;
  const dot = given.lastIndexOf(".");
  const pass = given.slice(0, dot);
  const mac = given.slice(dot + 1);
  if (dot < 1 || !/^[0-9a-f]{64}$/.test(mac)) return null;
  const want = Buffer.from(sessionMac(config, pass), "hex");
  return timingSafeEqual(want, Buffer.from(mac, "hex")) ? pass : null;
}
