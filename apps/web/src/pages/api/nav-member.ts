import type { APIRoute } from "astro";

export const prerender = false;

/**
 * The signed-in member's display name, or null, for the one place that cannot
 * learn it at render time: the handbook header.
 *
 * The handbook is Starlight, which prerenders its pages even under
 * `output: "server"` (astro.config.mjs), so its header is baked at build time
 * with no session and always renders the signed-out "Sign in" form. A small
 * script in HandbookHeader.astro fetches this per request and, when signed in,
 * swaps that form for a link to /me.
 *
 * `locals.member` is filled by the middleware for exactly the same signed-in
 * Members the SSR homepage greets (a session with a resolved Member row), so
 * the handbook stays consistent with the rest of the site. Per-request and
 * per-person: never cache it.
 */
export const GET: APIRoute = ({ locals }) => {
  return Response.json(
    { displayName: locals.member?.displayName ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
};
