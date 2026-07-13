import type { APIRoute } from "astro";
import { assertSameOrigin } from "../lib/forms.ts";
import { getAuth } from "../lib/auth.ts";

/**
 * Sign out, and land back on the front page rather than on Better Auth's
 * `{"success":true}`.
 *
 * Same shape as the sign-in route, and for the same reason: the Set-Cookie
 * headers are the *point* of the call (they clear the session cookie), so they
 * are copied onto the redirect. Redirect without them and the member is told
 * they signed out while still holding a valid session.
 */
export const POST: APIRoute = async ({ request }) => {
  assertSameOrigin(request);

  const response = await getAuth().api.signOut({
    headers: request.headers,
    asResponse: true,
  });

  const headers = new Headers({ Location: "/" });
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, { status: 303, headers });
};
