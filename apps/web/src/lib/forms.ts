import { getWebConfig } from "@7r/config";

/**
 * Every state-changing route is a plain HTML form POST, so every one of them
 * needs to know the request actually came from our own page.
 *
 * The session cookie is SameSite=Lax (Better Auth's default), which already
 * means a cross-site POST does not carry it, so a forged request arrives with no
 * session and dies in the middleware. This is the second lock: it costs one
 * comparison and it does not depend on browser defaults staying what they are
 * today.
 *
 * Lax is also the reason there is no token to thread through the forms: a
 * hidden-field CSRF token would be a session-state store, a rotation policy and
 * a way for the back button to break the page, to defend against something the
 * cookie policy has already refused.
 *
 * Returns the 403 for the caller to `return`, or `undefined` to proceed. It
 * returns rather than throws on purpose: Astro does not turn a `Response` thrown
 * from an endpoint into that response, it surfaces it as a 500, so the handler
 * has to return this itself.
 */
export function sameOriginGuard(request: Request): Response | undefined {
  const { PUBLIC_BASE_URL } = getWebConfig();
  const expected = new URL(PUBLIC_BASE_URL).origin;

  // Origin is sent on every cross-origin request and on every POST, including
  // same-origin ones, by every browser we care about. Its absence on a POST is
  // itself suspicious.
  const origin = request.headers.get("Origin");

  if (origin !== expected) {
    return new Response("cross-origin form submission refused", {
      status: 403,
    });
  }

  return undefined;
}

/**
 * Redirect back to a page, optionally with a message for the member.
 *
 * 303 See Other, which turns the POST into a GET. That is what stops a refresh
 * re-submitting the form, and it is why the outcome is carried in the query
 * string rather than in a flash-message store: there is no session state to
 * keep, and the back button cannot resurrect a stale one.
 */
export function redirectWith(
  path: string,
  params: Record<string, string> = {},
): Response {
  const query = new URLSearchParams(params).toString();
  return new Response(null, {
    status: 303,
    headers: { Location: query ? `${path}?${query}` : path },
  });
}
