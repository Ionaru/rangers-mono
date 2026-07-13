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

  const guildMember = await getGuildMember(
    { botToken: DISCORD_BOT_TOKEN },
    DISCORD_GUILD_ID,
    resolved.discordId,
  );

  if (!guildMember) {
    return context.redirect("/not-in-guild", 302);
  }

  context.locals.member = await upsertMemberOnLogin(db, {
    discordId: resolved.discordId,
    displayName: displayNameOf(guildMember, session.user.name),
  });

  return next();
});
