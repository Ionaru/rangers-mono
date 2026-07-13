import type { APIRoute } from "astro";
import { getSteamConfig, getWebConfig } from "@7r/config";
import { buildSteamLoginUrl } from "@7r/identity";

/**
 * Send the member to Steam.
 *
 * A GET, unusually for something that starts a flow, because it changes nothing:
 * no code is issued and no row is written. All that happens is a redirect to
 * Steam, and everything that matters is checked when they come back
 * (`callback.ts`).
 */
export const GET: APIRoute = () => {
  const { PUBLIC_BASE_URL } = getWebConfig();
  const { STEAM_REALM } = getSteamConfig();

  return new Response(null, {
    status: 302,
    headers: {
      Location: buildSteamLoginUrl({
        realm: STEAM_REALM,
        // Fixed by IMPLEMENTATION §4, and it must be inside the realm above or
        // Steam refuses the request outright.
        returnTo: `${PUBLIC_BASE_URL}/link/steam/callback`,
      }),
    },
  });
};
