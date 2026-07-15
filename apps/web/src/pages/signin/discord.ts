import type { APIRoute } from "astro";
import { sameOriginGuard } from "../../lib/forms.ts";
import { getAuth } from "../../lib/auth.ts";

/**
 * Start the Discord login.
 *
 * This exists rather than posting the form straight at Better Auth's
 * `/api/auth/sign-in/social`, because that endpoint answers with **JSON**
 * (`{ url, redirect }`) and expects a client-side script to navigate to `url`.
 * Posted to by a plain HTML form, it would render a page of JSON at the member.
 * Doing it here keeps this app free of client-side JavaScript entirely, which is
 * worth one small route.
 *
 * The Set-Cookie headers from Better Auth's response are copied onto the
 * redirect, and that is not optional: one of them is the OAuth **state** cookie,
 * which the callback checks to prove the response came back from the flow we
 * started. Drop it and every login fails at the callback with a state mismatch.
 */
export const POST: APIRoute = async ({ request }) => {
  const blocked = sameOriginGuard(request);
  if (blocked) return blocked;

  const response = await getAuth().api.signInSocial({
    body: { provider: "discord", callbackURL: "/me" },
    asResponse: true,
  });

  const { url } = await response.json() as { url?: string };

  if (!url) {
    // Better Auth had nothing to redirect to, which means it never built an
    // authorization URL. A misconfigured client id gets here.
    return new Response("could not start the Discord login", { status: 502 });
  }

  const headers = new Headers({ Location: url });
  for (const cookie of response.headers.getSetCookie()) {
    headers.append("Set-Cookie", cookie);
  }

  return new Response(null, { status: 303, headers });
};
