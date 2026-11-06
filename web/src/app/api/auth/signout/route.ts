import { NextResponse, type NextRequest } from "next/server";
import { cookieOptions, PENDING_COOKIE, SESSION_COOKIE, signinConfig } from "@/lib/signin";

/** Ends the session on this site. Only this site's own pages may ask. */
export async function POST(request: NextRequest) {
  const config = signinConfig();
  const origin = request.headers.get("origin");
  if (config && origin !== null && origin !== config.appUrl) {
    return Response.json({ state: "refused" }, { status: 403 });
  }
  const response = NextResponse.json({ state: "out" });
  response.headers.set("cache-control", "no-store");
  response.cookies.set(SESSION_COOKIE, "", cookieOptions(0));
  response.cookies.set(PENDING_COOKIE, "", cookieOptions(0));
  return response;
}
