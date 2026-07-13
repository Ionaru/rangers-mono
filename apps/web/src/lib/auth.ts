import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { authSchema, getDb } from "@7r/db";
import { getDiscordConfig, getWebConfig } from "@7r/config";

/**
 * Better Auth, with one provider: Discord, which is the site's only login
 * (ADR 0001).
 *
 * **Lazy, and it must stay lazy.** `astro build` executes module code, and
 * neither the build nor CI has a SESSION_SECRET, so constructing this at module
 * scope turns a missing production secret into a failed build (AGENTS.md). Every
 * caller goes through `getAuth()`.
 */

let cached: ReturnType<typeof create> | undefined;

function create() {
  const { PUBLIC_BASE_URL } = getWebConfig();
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET } =
    getDiscordConfig();

  return betterAuth({
    // Passed explicitly rather than through Better Auth's own BETTER_AUTH_SECRET
    // / BETTER_AUTH_URL environment variables, so that packages/config stays the
    // single place the environment is read and validated. Its default, if it
    // finds no secret, is a hardcoded development string.
    secret: SESSION_SECRET,
    baseURL: PUBLIC_BASE_URL,

    /**
     * `schema` is not optional here, whatever the types say.
     *
     * The adapter resolves a table as `config.schema[model]`, falling back to
     * `db._.fullSchema`, and that fallback only exists when `drizzle()` was
     * called with `{ schema }`. packages/db deliberately does not do that, so
     * that the relational query builder ADR 0008 forbids is unreachable. Omit
     * this and the first login dies with "The model 'user' was not found in the
     * schema object".
     *
     * And never turn on `experimental: { joins: true }`: that flag is the only
     * thing in the adapter that reaches for `db.query[...]`, which is exactly the
     * surface we do not have.
     */
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: authSchema,
    }),

    socialProviders: {
      discord: {
        clientId: DISCORD_CLIENT_ID,
        clientSecret: DISCORD_CLIENT_SECRET,

        /**
         * No `scope` is set, on purpose. Discord's defaults here are already
         * exactly `identify` + `email`, which is all we want, and asking for
         * `guilds` would buy nothing: Better Auth only ever calls
         * `/oauth2/token` and `/users/@me`, so it surfaces no guild data no
         * matter what is granted. Guild membership and roles come from the bot
         * token instead (IMPLEMENTATION §4, and see middleware.ts).
         */

        /**
         * Discord returns `email: null` for phone-only accounts even when the
         * `email` scope was granted, and Better Auth requires an email: the
         * sign-in then fails with `error=email_not_found`, which presents as
         * "login is broken for one person and nobody knows why".
         *
         * We never read this column. A synthetic address is honest about that
         * and costs nothing.
         */
        mapProfileToUser: (profile) => ({
          email: profile.email ?? `${profile.id}@discord.placeholder.invalid`,
        }),
      },
    },

    advanced: {
      /**
       * Set explicitly, because the default is wrong for us.
       *
       * Better Auth marks the session cookie `Secure` only when
       * `NODE_ENV === "production"`, and nothing sets NODE_ENV in these Deno
       * containers, so in production the session cookie would go out over HTTPS
       * **without the Secure flag**. Deriving it from the base URL is correct in
       * both places at once: `Secure` in production, and not on
       * http://localhost, where a Secure cookie would simply never be sent back
       * and the login would appear to silently do nothing.
       */
      useSecureCookies: PUBLIC_BASE_URL.startsWith("https:"),
    },
  });
}

export function getAuth(): ReturnType<typeof create> {
  return cached ??= create();
}

/**
 * The Discord OAuth redirect URI, which has to be registered on `7R_Bot`'s
 * application in the Discord developer portal or the login fails at Discord's
 * end with an invalid-redirect error.
 *
 * Exported so it can be printed rather than remembered.
 */
export function discordRedirectUri(baseUrl: string): string {
  return `${baseUrl}/api/auth/callback/discord`;
}
