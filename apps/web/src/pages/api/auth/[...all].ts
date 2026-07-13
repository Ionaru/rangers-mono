import type { APIRoute } from "astro";
import { getAuth } from "../../../lib/auth.ts";

/**
 * Better Auth's own routes: the OAuth callback, the session endpoint, and the
 * rest of its surface. It owns everything under /api/auth/.
 *
 * `ALL`, because it handles its own method routing.
 *
 * The Discord developer portal must have this application's redirect URI
 * registered as `<PUBLIC_BASE_URL>/api/auth/callback/discord`, or the login dies
 * at Discord's end before it ever reaches us.
 */
export const ALL: APIRoute = ({ request }) => getAuth().handler(request);
