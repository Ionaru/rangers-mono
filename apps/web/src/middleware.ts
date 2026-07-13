import { defineMiddleware } from "astro:middleware";
import { getDiscordConfig } from "@7r/config";
import { findMemberForAuthUser, getDb, upsertMemberOnLogin } from "@7r/db";
import { displayNameOf, getGuildMember } from "@7r/discord";
import { getAuth } from "./lib/auth.ts";

/**
 * Resolve the session, resolve the Member behind it, and enforce the guild gate.
 *
 * Every page below can then assume `locals.member` is a Member of this unit, or
 * that it was redirected away.
 */

/**
 * What a signed-out visitor may reach. Everything else needs a session.
 *
 * `/signin/discord` has to be in here, and forgetting it is a good bug: the
 * route that *starts* the login is naturally reached without a session, so
 * gating it on one makes signing in redirect you to the page you were already
 * on, forever, with no error anywhere.
 */
const PUBLIC_PATHS = new Set([
  "/",
  "/signin/discord",
  "/not-in-guild",
  "/healthz",
]);

function isPublic(pathname: string): boolean {
  // /api/auth/* is Better Auth's own surface, and the OAuth callback lands there
  // before any session exists.
  return PUBLIC_PATHS.has(pathname) || pathname.startsWith("/api/auth/");
}

export const onRequest = defineMiddleware(async (context, next) => {
  const auth = getAuth();
  const session = await auth.api.getSession({
    headers: context.request.headers,
  });

  context.locals.user = session?.user ?? null;
  context.locals.session = session?.session ?? null;
  context.locals.member = null;

  if (!session) {
    return isPublic(context.url.pathname) ? next() : context.redirect("/", 302);
  }

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
    // it means the account was deleted underneath the session.
    return context.redirect("/", 302);
  }

  if (resolved.member) {
    context.locals.member = resolved.member;
    return next();
  }

  /**
   * First login: they have a Discord account but no Member row yet.
   *
   * **This is the guild gate, and it is the only thing between "has a Discord
   * account" and "is one of us".** Ask Discord, as the bot, whether they are in
   * the guild. A 404 is the answer, not an error: they get told so and no Member
   * row is written for them.
   *
   * This costs one Discord API call per person, ever. Every subsequent request
   * finds the Member row above and never gets here. A member who later *leaves*
   * the guild is not this function's problem: Phase 3's role sync stamps
   * `disabled_at` on them (ARCHITECTURE §4.4).
   *
   * Deliberately NOT done in a Better Auth `databaseHooks.user.create.before`
   * hook. Whether throwing from that hook aborts a *social* sign-in cleanly, or
   * leaves a half-created user and a 500, is not something the docs commit to,
   * and this needs no unverified behaviour to work.
   */
  const { DISCORD_GUILD_ID, DISCORD_BOT_TOKEN } = getDiscordConfig();

  let guildMember;
  try {
    guildMember = await getGuildMember(
      { botToken: DISCORD_BOT_TOKEN },
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
    console.error(
      "[web] the Discord guild check failed, so the login could not be completed.",
      "This is usually a Phase 0 step: a bad DISCORD_BOT_TOKEN, the bot not being",
      "in the guild, or the GUILD_MEMBERS privileged intent. Run `deno task",
      "phase0:check` to find out which.",
      cause,
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
