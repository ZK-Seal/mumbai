/**
 * Keeps a picture on Swarm. The file goes up through a Swarm gateway, which answers with the
 * file's reference; anyone can then fetch it back from any gateway by that reference. Through a
 * public gateway with its own stamp, nothing promises how long the file is kept.
 */

export type SwarmSettings = {
  /** The gateway that takes uploads. */
  apiUrl: string;
  /** The postage stamp to pay with: 64 hex characters. All zeros lets the gateway use its own. */
  stamp: string;
  /** The gateway that pictures are shown from. */
  viewUrl: string;
};

const ZERO_STAMP = "0".repeat(64);

/**
 * How long one upload may take before it is given up. The public gateway has been seen to take
 * close to a minute for a 2 MB file, so this stays just under the time a hosted request may run.
 */
const UPLOAD_TIMEOUT_MS = 55000;

function baseUrl(value: string | undefined, fallback: string): string {
  const url = (value || fallback).replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(url) ? url : fallback;
}

/**
 * Reads the Swarm settings from the environment: SWARM_API_URL, SWARM_STAMP and SWARM_VIEW_URL,
 * each with a public default.
 */
export function swarmSettings(): SwarmSettings {
  const stamp = (process.env.SWARM_STAMP ?? "").toLowerCase();
  return {
    apiUrl: baseUrl(process.env.SWARM_API_URL, "https://api.gateway.ethswarm.org"),
    stamp: /^[0-9a-f]{64}$/.test(stamp) ? stamp : ZERO_STAMP,
    viewUrl: baseUrl(process.env.SWARM_VIEW_URL, "https://download.gateway.ethswarm.org"),
  };
}

/** A Swarm reference, as 64 lowercase hex characters. */
export function isSwarmRef(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** The public address of a picture kept on Swarm. */
export function pictureUrl(ref: string, settings: SwarmSettings = swarmSettings()): string {
  if (!isSwarmRef(ref)) throw new Error("not a swarm reference");
  return `${settings.viewUrl}/bzz/${ref}/`;
}

/** Swarm did not take the picture, so nothing was kept. */
export class SwarmError extends Error {
  readonly word = "storage";
  constructor(cause?: unknown) {
    super("storage", { cause });
  }
}

/**
 * Uploads one JPEG to Swarm and returns its reference. Throws a SwarmError for any failure: the
 * gateway cannot be reached, takes too long, refuses, or answers with something that is not a
 * reference.
 */
export async function uploadPicture(
  bytes: Uint8Array,
  name: string,
  settings: SwarmSettings = swarmSettings(),
): Promise<string> {
  const fileName = /^[A-Za-z0-9._-]{1,80}$/.test(name) ? name : "picture.jpg";
  let response: Response;
  try {
    response = await fetch(`${settings.apiUrl}/bzz?name=${encodeURIComponent(fileName)}`, {
      method: "POST",
      headers: { "content-type": "image/jpeg", "swarm-postage-batch-id": settings.stamp },
      body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SwarmError(error);
  }
  if (!response.ok) throw new SwarmError(response.status);
  const answer = (await response.json().catch(() => null)) as { reference?: unknown } | null;
  if (!isSwarmRef(answer?.reference)) throw new SwarmError();
  return answer.reference;
}
