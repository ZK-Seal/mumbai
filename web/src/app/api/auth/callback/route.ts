import { connection, NextResponse, type NextRequest } from "next/server";
import {
  backUrl,
  cookieOptions,
  finishSignin,
  PENDING_COOKIE,
  readPending,
  sessionCookie,
  signinConfig,
  SigninError,
  type SigninWord,
} from "@/lib/signin";

/**
 * Where World sends the person back. The attempt is used up whatever happens. Every failure
 * goes back to the page with one fixed word and no session.
 */
export async function GET(request: NextRequest) {
  await connection();
  const config = signinConfig();
  if (!config) return new Response(null, { status: 303, headers: { location: "/" } });

  const pending = await readPending(config, request.cookies.get(PENDING_COOKIE)?.value);

  function back(word?: SigninWord) {
    const response = NextResponse.redirect(backUrl(config!, pending?.back ?? "/", word), 303);
    response.cookies.set(PENDING_COOKIE, "", cookieOptions(0));
    response.headers.set("cache-control", "no-store");
    return response;
  }

  if (!pending) return back("expired");
  let session;
  try {
    session = await finishSignin(config, pending, request.nextUrl.searchParams);
  } catch (error) {
    return back(error instanceof SigninError ? error.word : "failed");
  }
  const response = back();
  const cookie = await sessionCookie(config, session);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
