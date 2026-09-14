import { defineMiddleware } from "astro:middleware";
// Type-only, so it is erased before the bundler sees it and cannot drag
// @7r/logging into the prerender step the way a value import would.
import type { LoggingOptions } from "@7r/logging";

/**
 * Resolve the session, resolve the Member behind it, and gate the member area.
 *
 * Phase 3 makes most of the site public (homepage, handbook, briefing
 * generator). So the model is inverted from Phase 2: instead of a default-deny
 * allowlist, only the **member area** needs a session. Everything else is
 * public, and a public page still gets `locals.member` populated when a session
 * happens to exist, so its nav can be login-aware.
 *
 * Two structural rules make this work with Starlight:
 *
 * 1. **Prerendered routes are skipped.** The handbook (Starlight) is prerendered:
 *    static files at runtime that never reach this middleware. (The about and
 *    briefing-generator pages used to be too, but are now server-rendered so
 *    their header can greet a signed-in member.) Astro still runs middleware
 *    while *prerendering* the handbook at build time, where there is no session
 *    and no database, so `context.isPrerendered` short-circuits before any I/O.
 * 2. **The heavy modules are imported dynamically, below that guard.** Astro
 *    bundles this middleware into the prerender step, and a *static* `import` of
 *    `@7r/db` (drizzle-orm) or Better Auth would be pulled in with it and fail
 *    to resolve there. Dynamic imports keep the prerender bundle backend-free.
 */

/**
 * The member area: the only routes that require a signed-in Member. Everything
 * else is public. `/api/auth/*` is deliberately absent (Better Auth's own
 * surface, incl. the OAuth callback, must be reachable without a session).
 */
function needsSession(pathname: string): boolean {
  return (
    pathname === "/me" ||
    pathname.startsWith("/me/") ||
    // Phase 6. A top-level path rather than /me/attendance because it is the
    // unit's attendance, not yours; the page gates itself to admins on top of
    // this (ADR 0009, lib/admin.ts).
    pathname === "/attendance" ||
    pathname.startsWith("/link/") ||
    pathname.startsWith("/unlink/") ||
    pathname === "/signout"
  );
}

/**
 * Whether this process has installed its logging policy yet (ADR 0019). The
 * first server-rendered request does it; this flag keeps the imports and the
 * config read off every request after that, which matters because the install
 * block sits in front of the Discord interactions endpoint and its 3-second
 * budget. Set only once `configureLogging` returns, for the same reason the
 * package's own latch is: a failed install must be retried, not remembered.
 */
let loggingInstalled = false;

export const onRequest = defineMiddleware(async (context, next) => {
  // Prerendered public content (the Starlight handbook) is static at runtime and
  // never hits this middleware then; at build time there is no session or DB to
  // consult. Skip before importing or touching anything.
  if (context.isPrerendered) return next();

  /**
   * Logging, installed once per process (ADR 0019).
   *
   * Astro has no startup hook, so the first server-rendered request installs
   * it and every one after that skips on the module-scope flag above. It
   * belongs **below** the prerender guard and **above** the interactions
   * short-circuit: below, because reading `LOG_LEVEL` parses the environment
   * and the build has none; above, because the interactions endpoint and the
   * handlers it defers are the loudest thing in this app.
   *
   * **Reading the level may not fail a request.** Being above that
   * short-circuit puts this in front of the Discord interactions endpoint,
   * which until now answered a PING without touching config at all; a config
   * parse that throws there would turn a missing `DATABASE_URL` into an
   * endpoint Discord cannot verify, which is the silent bot death §8 is built
   * to avoid. So the *read* is guarded and falls back to the default level.
   *
   * `configureLogging` itself is not guarded, deliberately. It parses nothing
   * and can only fail on a mistake inside `@7r/logging`, which is a programming
   * error that should be as loud here as the worker's boot already makes it,
   * not something to swallow per request. Calling it exactly once, outside the
   * catch, is also what keeps a failed read from turning into two throwing
   * calls.
   */
  if (!loggingInstalled) {
    const { configureLogging } = await import("@7r/logging");
    let level: LoggingOptions["level"];
    try {
      const { getCoreConfig } = await import("@7r/config");
      level = getCoreConfig().LOG_LEVEL;
    } catch {
      // Unreadable config: log at the default level rather than not at all.
    }
    configureLogging({ level });
    loggingInstalled = true;
  }

  // The Discord interactions endpoint authenticates every request by an Ed25519
  // signature, not a session cookie (ADR 0003). Running the session lookup and
  // its database round-trip for it would spend part of the 3-second interaction
  // budget on a request that has no cookie and never will. Skip straight through.
  if (context.url.pathname.startsWith("/api/discord/")) return next();

  const gated = needsSession(context.url.pathname);

  const { getAuth } = await import("./lib/auth.ts");
  const session = await getAuth().api.getSession({
    headers: context.request.headers,
  });

  context.locals.user = session?.user ?? null;
  context.locals.session = session?.session ?? null;
  context.locals.member = null;

  // No session: public routes proceed; the member area bounces to the homepage.
  if (!session) {
    return gated ? context.redirect("/", 302) : next();
  }

  const { findMemberForAuthUser, getDb, upsertMemberOnLogin } = await import(
    "@7r/db"
  );
  const db = getDb();

  /**
   * A session names a Better Auth user. A Member is keyed by Discord snowflake.
   * `auth_account.account_id` is that snowflake, so one join gets us both, and
   * nothing had to be bolted onto Better Auth's own tables to make it work
   * (auth-schema.ts).
   */
  const resolved = await findMemberForAuthUser(db, session.user.id);

  if (!resolved) {
    // A session whose user has no Discord account row. Better Auth creates the
    // two together for a social sign-in, so this is not reachable by logging in;
    // it means the account was deleted underneath the session. Treat as signed
    // out: block the member area, let public routes through.
    return gated ? context.redirect("/", 302) : next();
  }

  if (resolved.member) {
    context.locals.member = resolved.member;
    return next();
  }

  /**
   * A session with a Discord account but no Member row yet. On a public route we
   * do not force the question: they browse as a signed-in-but-unresolved
   * visitor (no `locals.member`), and no Discord call is made. The guild gate
   * below only runs when they actually reach the member area.
   */
  if (!gated) {
    return next();
  }

  /**
   * First member-area access: they have a Discord account but no Member row.
   *
   * **This is the guild gate, and it is the only thing between "has a Discord
   * account" and "is one of us".** Ask Discord, as the bot, whether they are in
   * the guild. A 404 is the answer, not an error: they get told so and no Member
   * row is written for them.
   *
   * This costs one Discord API call per person, ever. Every subsequent request
   * finds the Member row above and never gets here. A member who later *leaves*
   * the guild is not this function's problem: Phase 4's role sync stamps
   * `disabled_at` on them (ARCHITECTURE §4.4).
   *
   * Deliberately NOT done in a Better Auth `databaseHooks.user.create.before`
   * hook. Whether throwing from that hook aborts a *social* sign-in cleanly, or
   * leaves a half-created user and a 500, is not something the docs commit to,
   * and this needs no unverified behaviour to work.
   */
  const { getDiscordConfig } = await import("@7r/config");
  const { displayNameOf, getGuildMember } = await import("@7r/discord");
  const { DISCORD_GUILD_ID, DISCORD_BOT_TOKEN } = getDiscordConfig();

  let guildMember;
  try {
    guildMember = await getGuildMember(
      {
        botToken: DISCORD_BOT_TOKEN,
        /**
         * One try, and a short one. The REST client retries transient Discord
         * failures by default, which is right for the worker's five-minute loop
         * and wrong here: somebody is watching a blank page, and the 503 below
         * is a good answer they can act on. It is also reachable more than once
         * per person, because neither the 503 nor the not-in-guild redirect
         * writes a Member row, so the next request comes straight back here.
         */
        retry: { transientAttempts: 1, timeoutMs: 5_000 },
      },
      DISCORD_GUILD_ID,
      resolved.discordId,
    );
  } catch (cause) {
    /**
     * Discord answered, but not with an answer: a 403 (the bot's permissions or
     * a privileged intent), a 401 (a bad token), a 429, or an outage.
     *
     * We cannot tell whether this person is one of us, so we do not guess. Fail
     * closed: no Member row is written, and they are told the truth.
     *
     * Answered here rather than redirected, deliberately. A redirect would come
     * straight back through this middleware, still with a session and still with
     * no Member row, and hit this same call again: a redirect loop, in front of
     * somebody who has done nothing wrong. Returning the response ends it.
     *
     * The most likely cause on day one is a Phase 0 step that was missed, so say
     * so, and put it where an operator will see it (the logs) rather than only in
     * front of a member who cannot act on it.
     */
    const { getLogger, ROOT_CATEGORY } = await import("@7r/logging");
    getLogger([ROOT_CATEGORY, "web", "auth"]).error(
      "the Discord guild check failed, so the login could not be completed. " +
        "This is usually a Phase 0 step: a bad DISCORD_BOT_TOKEN, the bot not " +
        "being in the guild, or the GUILD_MEMBERS privileged intent. Run " +
        "`deno task phase0:check` to find out which.",
      { discordId: resolved.discordId, error: String(cause) },
    );

    return new Response(
      "<!doctype html><meta charset=utf-8><title>Sign-in failed</title>" +
        "<p>We could not check your membership with Discord, so we have not signed you in. " +
        "This is our problem, not yours. Please try again in a few minutes.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  if (!guildMember) {
    return context.redirect("/not-in-guild", 302);
  }

  context.locals.member = await upsertMemberOnLogin(db, {
    discordId: resolved.discordId,
    displayName: displayNameOf(guildMember, session.user.name),
  });

  return next();
});
