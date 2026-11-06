import { createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, EncryptJWT, jwtDecrypt, jwtVerify, type JWTPayload } from "jose";

/**
 * Sign in with World: the OpenID Connect provider at auth.world.org. Authorization code flow
 * with PKCE (S256), a fresh state and nonce for every attempt, and a fresh check of the person
 * each time (max_age=0) with the credential class we ask for.
 */

export type SigninConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The public origin of this site, e.g. https://example.com. */
  appUrl: string;
  redirectUri: string;
  /** The credential class (acr) a session must have reached. */
  acr: string;
  secret: string;
};

/** The words a failed sign-in comes back with. Never the provider's own text. */
export type SigninWord = "denied" | "expired" | "failed" | "class";

export type Session = { iss: string; sub: string; acr: string; authTime: number };

/** Where a session stands for the protected action. */
export type Standing = "fresh" | "stale" | "other";

export const PENDING_COOKIE = "__Host-signin-pending";
export const SESSION_COOKIE = "__Host-signin";

const PENDING_SECONDS = 10 * 60;
const SESSION_SECONDS = 30 * 60;
/** How old a sign-in may be when the protected action happens. */
export const FRESH_SECONDS = 5 * 60;
const SKEW_SECONDS = 60;
const DISCOVERY_SECONDS = 10 * 60;

/**
 * Plain http is accepted only when the host is this machine. That is there so the flow can be
 * tried against a stand-in provider during development; anything else must be https.
 */
function allowedUrl(value: string, allowHttp: boolean): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && allowHttp && isLocalHost(url.hostname)) return url;
  return null;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Reads the sign-in settings from the environment. Null means sign-in is not set up. */
export function signinConfig(): SigninConfig | null {
  const clientId = process.env.WORLD_AUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.WORLD_AUTH_CLIENT_SECRET ?? "";
  const secret = process.env.SESSION_SECRET ?? "";
  const rawApp = process.env.APP_URL ?? "";
  if (clientId === "" || clientSecret === "" || rawApp === "" || secret.length < 32) return null;

  const issuer = (process.env.WORLD_AUTH_ISSUER || "https://auth.world.org").replace(/\/$/, "");
  const issuerUrl = allowedUrl(issuer, true);
  if (!issuerUrl || issuerUrl.search) return null;
  const local = issuerUrl.protocol === "http:";
  const app = allowedUrl(rawApp, local);
  if (!app) return null;

  return {
    issuer,
    clientId,
    clientSecret,
    appUrl: app.origin,
    redirectUri: `${app.origin}/api/auth/callback`,
    acr: process.env.WORLD_AUTH_ACR || "https://world.org/oidc/acr/orb",
    secret,
  };
}

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

let discovered: { issuer: string; doc: Discovery; until: number } | null = null;
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Fetches the provider's discovery document, kept for a few minutes. */
export async function discovery(config: SigninConfig): Promise<Discovery> {
  const now = Date.now();
  if (discovered && discovered.issuer === config.issuer && discovered.until > now) {
    return discovered.doc;
  }
  const local = new URL(config.issuer).protocol === "http:";
  const response = await fetch(`${config.issuer}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("discovery");
  const doc = (await response.json()) as Partial<Record<string, unknown>>;
  if (doc.issuer !== config.issuer) throw new Error("discovery");
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (typeof doc[key] !== "string" || !allowedUrl(doc[key] as string, local)) {
      throw new Error("discovery");
    }
  }
  const methods = doc.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) throw new Error("discovery");
  const algs = doc.id_token_signing_alg_values_supported;
  if (Array.isArray(algs) && !algs.includes("RS256")) throw new Error("discovery");

  const found = doc as unknown as Discovery;
  discovered = { issuer: config.issuer, doc: found, until: now + DISCOVERY_SECONDS * 1000 };
  return found;
}

function keySet(uri: string) {
  let set = keySets.get(uri);
  if (!set) {
    set = createRemoteJWKSet(new URL(uri), { timeoutDuration: 10000 });
    keySets.set(uri, set);
  }
  return set;
}

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** One sign-in attempt, kept in a short-lived cookie until the provider sends the person back. */
export type Pending = {
  state: string;
  nonce: string;
  verifier: string;
  /** The page to go back to: always a path under /authorise, or "/". */
  back: string;
  /** When the attempt began, in seconds. */
  started: number;
};

export function newPending(back: string): Pending {
  return {
    state: token(),
    nonce: token(),
    verifier: token(48),
    back,
    started: Math.floor(Date.now() / 1000),
  };
}

/**
 * Only pages under /authorise may be returned to, written as a plain path with a plain query.
 * Anything else goes back to the home page.
 */
export function safeBack(value: string | null): string {
  if (typeof value !== "string" || value.length > 1024) return "/";
  return /^\/authorise(\?[A-Za-z0-9\-._~%&=+]*)?$/.test(value) ? value : "/";
}

/** The page to send the person back to, with a word when sign-in did not work. */
export function backUrl(config: SigninConfig, back: string, word?: SigninWord): URL {
  const url = new URL(safeBack(back), config.appUrl);
  url.searchParams.delete("signin");
  if (word) url.searchParams.set("signin", word);
  return url;
}

/** The provider's sign-in page for this attempt. */
export function authorizationUrl(config: SigninConfig, doc: Discovery, pending: Pending): URL {
  const url = new URL(doc.authorization_endpoint);
  const challenge = createHash("sha256").update(pending.verifier).digest("base64url");
  const claims = { id_token: { acr: { essential: true, values: [config.acr] } } };
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "openid");
  url.searchParams.set("state", pending.state);
  url.searchParams.set("nonce", pending.nonce);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("max_age", "0");
  url.searchParams.set("claims", JSON.stringify(claims));
  return url;
}

export class SigninError extends Error {
  constructor(readonly word: SigninWord) {
    super(word);
  }
}

/** States already answered by this server, so a callback cannot be used twice here. */
const answered = new Map<string, number>();

function markAnswered(state: string): boolean {
  const now = Date.now();
  for (const [key, until] of answered) if (until < now) answered.delete(key);
  if (answered.has(state)) return false;
  answered.set(state, now + PENDING_SECONDS * 1000);
  return true;
}

/**
 * Checks what the provider sent back, redeems the code and checks the ID token. Throws a
 * SigninError with one fixed word on anything unexpected.
 */
export async function finishSignin(
  config: SigninConfig,
  pending: Pending,
  query: URLSearchParams,
): Promise<Session> {
  const state = query.get("state") ?? "";
  if (state === "" || !same(state, pending.state)) throw new SigninError("failed");
  if (query.get("iss") !== config.issuer) throw new SigninError("failed");
  if (!markAnswered(pending.state)) throw new SigninError("expired");

  const error = query.get("error");
  if (error !== null) {
    if (error === "unmet_authentication_requirements") throw new SigninError("class");
    if (error === "access_denied" || error === "login_required" || error === "consent_required") {
      throw new SigninError("denied");
    }
    throw new SigninError("failed");
  }
  const code = query.get("code") ?? "";
  if (code === "") throw new SigninError("failed");

  let doc: Discovery;
  try {
    doc = await discovery(config);
  } catch {
    throw new SigninError("failed");
  }

  let idToken: unknown;
  try {
    const basic = Buffer.from(
      `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
    ).toString("base64");
    const response = await fetch(doc.token_endpoint, {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
        code_verifier: pending.verifier,
      }),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("token");
    idToken = ((await response.json()) as { id_token?: unknown })?.id_token;
  } catch {
    throw new SigninError("failed");
  }
  if (typeof idToken !== "string") throw new SigninError("failed");

  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(idToken, keySet(doc.jwks_uri), {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat", "nonce", "auth_time", "acr"],
      maxTokenAge: PENDING_SECONDS,
      clockTolerance: SKEW_SECONDS,
    }));
  } catch {
    throw new SigninError("failed");
  }
  const { sub, nonce, acr, auth_time: authTime, aud, azp } = claims as JWTPayload & {
    nonce?: unknown;
    acr?: unknown;
    auth_time?: unknown;
    azp?: unknown;
  };
  if (typeof nonce !== "string" || !same(nonce, pending.nonce)) throw new SigninError("failed");
  if (azp !== undefined && azp !== config.clientId) throw new SigninError("failed");
  if (Array.isArray(aud) && aud.length > 1 && azp !== config.clientId) {
    throw new SigninError("failed");
  }
  if (typeof sub !== "string" || sub === "" || sub.length > 255) throw new SigninError("failed");
  if (typeof acr !== "string" || acr === "") throw new SigninError("failed");
  // We asked for a fresh check (max_age=0), so the person must have been checked after the
  // attempt began.
  const now = Math.floor(Date.now() / 1000);
  if (
    typeof authTime !== "number" ||
    authTime < pending.started - SKEW_SECONDS ||
    authTime > now + SKEW_SECONDS
  ) {
    throw new SigninError("expired");
  }
  return { iss: config.issuer, sub, acr, authTime };
}

type Use = "pending" | "session";

/** A different key for each cookie, both drawn from SESSION_SECRET. */
function cookieKey(config: SigninConfig, use: Use): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", config.secret, "", `signin ${use} cookie`, 32));
}

async function seal(config: SigninConfig, use: Use, data: object, seconds: number) {
  return new EncryptJWT({ ...data })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .encrypt(cookieKey(config, use));
}

async function unseal(config: SigninConfig, use: Use, value: string | undefined) {
  if (!value) return null;
  try {
    const { payload } = await jwtDecrypt(value, cookieKey(config, use), {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function cookieOptions(seconds: number) {
  return { httpOnly: true, secure: true, sameSite: "lax" as const, path: "/", maxAge: seconds };
}

export async function pendingCookie(config: SigninConfig, pending: Pending) {
  return {
    name: PENDING_COOKIE,
    value: await seal(config, "pending", pending, PENDING_SECONDS),
    options: cookieOptions(PENDING_SECONDS),
  };
}

export async function readPending(config: SigninConfig, value: string | undefined) {
  const p = await unseal(config, "pending", value);
  if (
    typeof p?.state !== "string" ||
    typeof p.nonce !== "string" ||
    typeof p.verifier !== "string" ||
    typeof p.back !== "string" ||
    typeof p.started !== "number"
  ) {
    return null;
  }
  const back = safeBack(p.back);
  return { state: p.state, nonce: p.nonce, verifier: p.verifier, back, started: p.started };
}

export async function sessionCookie(config: SigninConfig, session: Session) {
  return {
    name: SESSION_COOKIE,
    value: await seal(config, "session", session, SESSION_SECONDS),
    options: cookieOptions(SESSION_SECONDS),
  };
}

export async function readSession(config: SigninConfig, value: string | undefined) {
  const s = await unseal(config, "session", value);
  if (
    s?.iss !== config.issuer ||
    typeof s.sub !== "string" ||
    typeof s.acr !== "string" ||
    typeof s.authTime !== "number"
  ) {
    return null;
  }
  return { iss: s.iss, sub: s.sub, acr: s.acr, authTime: s.authTime } as Session;
}

/** Fresh: checked in the last five minutes with the class we require. */
export function standing(config: SigninConfig, session: Session): Standing {
  if (session.acr !== config.acr) return "other";
  const age = Math.floor(Date.now() / 1000) - session.authTime;
  return age >= -SKEW_SECONDS && age <= FRESH_SECONDS ? "fresh" : "stale";
}

/** A short, stable name for an account that does not reveal its subject. */
export function accountName(session: Session): string {
  return createHash("sha256").update(`${session.iss}|${session.sub}`).digest("hex").slice(0, 16);
}
