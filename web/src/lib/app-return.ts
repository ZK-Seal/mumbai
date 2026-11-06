/**
 * The way back to the phone app after a seal is authorised. The address is a fixed server
 * setting (APP_RETURN_URL); it is never taken from a request. Unset means the way back is off.
 */

/** The only states the app is ever told. */
export type AppState = "authorised" | "cancelled";

export type AppReturn = Record<AppState, string>;

/** Schemes that run or read something in the browser; never a way back to an app. */
const REFUSED = new Set(["http:", "javascript:", "data:", "vbscript:", "file:", "blob:", "about:"]);

/**
 * Reads APP_RETURN_URL: the app's own scheme (for example blankdemo://authorised) or an https
 * address, with no query, fragment or credentials of its own. Null when unset or not valid.
 */
export function appReturnBase(): string | null {
  const raw = process.env.APP_RETURN_URL ?? "";
  if (raw === "" || raw.length > 256) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!/^[a-z][a-z0-9+.-]*:$/.test(url.protocol) || REFUSED.has(url.protocol)) return null;
  if (url.username || url.password || url.search || url.hash || raw.includes("?")) return null;
  return url.href;
}

/** The two links back to the app for one seal: they carry the hash and the state, nothing else. */
export function appReturn(hash: string): AppReturn | null {
  const base = appReturnBase();
  if (!base) return null;
  function link(state: AppState): string {
    const url = new URL(base!);
    url.searchParams.set("hash", hash);
    url.searchParams.set("state", state);
    return url.href;
  }
  return { authorised: link("authorised"), cancelled: link("cancelled") };
}
