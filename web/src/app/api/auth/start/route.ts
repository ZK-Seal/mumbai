import { connection, NextResponse, type NextRequest } from "next/server";
import {
  authorizationUrl,
  backUrl,
  discovery,
  newPending,
  pendingCookie,
  safeBack,
  signinConfig,
} from "@/lib/signin";

/** Sends the person to World to sign in, then back to the page they came from. */
export async function GET(request: NextRequest) {
  await connection();
  const back = safeBack(request.nextUrl.searchParams.get("return"));
  const config = signinConfig();
  if (!config) {
    return new Response(null, { status: 303, headers: { location: back } });
  }
  let doc;
  try {
    doc = await discovery(config);
  } catch {
    return NextResponse.redirect(backUrl(config, back, "failed"), 303);
  }
  const pending = newPending(back);
  const response = NextResponse.redirect(authorizationUrl(config, doc, pending), 303);
  const cookie = await pendingCookie(config, pending);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  response.headers.set("cache-control", "no-store");
  return response;
}
