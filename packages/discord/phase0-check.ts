import { getDiscordConfig, getWebConfig, loadAll } from "@7r/config";
import type { DiscordConfig, WebConfig } from "@7r/config";
import { badgeFromDisplayName, BADGES } from "@7r/domain";
import { discordJson, type DiscordRestOptions } from "./rest.ts";

/**
 * Phase 0 preflight. Read-only, and it asks Discord rather than asking you.
 *
 * Phase 0 is the manual, no-code prep: stand `7R_Bot` up as the platform's
 * Discord application, put it above the roles it must write, create the badge
 * roles, and so on (ARCHITECTURE §9). Almost every way of getting it wrong fails
 * **silently**: the bot looks healthy and every write 403s, or the member poll is
 * refused and the sync quietly does nothing. So this checks, rather than
 * believing.
 *
 *   deno task phase0:check
 *
 * Seven GETs, no writes, nothing registered, no interactions URL touched. Safe to
 * run against production, and it is meant to be: the credentials only exist on
 * the box.
 *
 * What it CANNOT check, and why:
 *   - whether the public origin exists and terminates TLS (that is nginx, on a
 *     box this project does not own: ADR 0005),
 *   - whether the TeamSpeak ServerQuery login works (`docker compose ps` answers
 *     that: the worker treats a failed connect at boot as fatal),
 *   - whether a `/loa` registered by the *2019* application still exists. Command
 *     endpoints are namespaced per application, so `7R_Bot`'s token cannot see
 *     another app's commands. If members still see a stale `/loa` after Phase 5,
 *     that is where it lives, and only the old app's credentials can remove it.
 */

/** The five ranks and three roles, with the Discord ids the legacy dump carries (MIGRATION.md). */
const KNOWN_ASSIGNABLES = [
  { kind: "rank", name: "Officer", id: "308218743085989888" },
  { kind: "rank", name: "NCO", id: "308219154396217344" },
  { kind: "rank", name: "Member", id: "308221089681637376" },
  { kind: "rank", name: "Recruit", id: "440484951507599370" },
  { kind: "rank", name: "Reserve", id: "657877767186022412" },
  { kind: "role", name: "Recruiter", id: "432647112275001358" },
  { kind: "role", name: "Instructor", id: "455066329532203008" },
  { kind: "role", name: "Mission maker", id: "432647098517684246" },
];

/**
 * The eight badges, from `@7r/domain` so there is one source of truth for the
 * names (this file used to keep its own copy). A badge role wears an emoji in
 * Discord ("🎖️ Medic"), so it is matched with `badgeFromDisplayName`, not by
 * string equality: a raw `r.name === "Medic"` would report every badge missing.
 */
const BADGE_NAMES = BADGES;

/**
 * Permission bits, as BigInt, and that is not fussiness.
 *
 * Discord serialises permissions as a decimal STRING because they exceed 53 bits,
 * and JavaScript's `<<` is a 32-bit operation: `1 << 44` evaluates to 4096, which
 * is CREATE_INSTANT_INVITE. A preflight that used Numbers would cheerfully report
 * that a bot with the invite permission can create scheduled events.
 */
const ADMINISTRATOR = 1n << 3n;
const MANAGE_ROLES = 1n << 28n;
const MANAGE_EVENTS = 1n << 33n;
const CREATE_EVENTS = 1n << 44n;

/** GUILD_MEMBERS intent, as reported on the application's own flags. */
const GATEWAY_GUILD_MEMBERS = 1 << 14;
const GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;

interface Role {
  id: string;
  name: string;
  position: number;
  permissions: string;
  managed: boolean;
}

type Status = "ok" | "warn" | "fail" | "unknown";

const results: { status: Status; title: string; detail: string }[] = [];

function record(status: Status, title: string, detail: string) {
  results.push({ status, title, detail });
}

async function main() {
  const [discord, web] = loadAll<[DiscordConfig, WebConfig]>([
    getDiscordConfig,
    getWebConfig,
  ]);

  const auth: DiscordRestOptions = { botToken: discord.DISCORD_BOT_TOKEN };
  const guildId = discord.DISCORD_GUILD_ID;

  // ---------------------------------------------------------------- the application

  const app = await discordJson<{
    id: string;
    name: string;
    flags?: number;
    redirect_uris?: string[];
    bot?: { id: string; username: string };
  }>(auth, "/applications/@me");

  record(
    "ok",
    "Bot token is valid",
    `application "${app.name}" (${app.id}), bot user ${
      app.bot?.username ?? "?"
    }`,
  );

  /**
   * All four Discord values must come from ONE application. Mixing them is a
   * silent 401 on every interaction, after which Discord removes the endpoint
   * URL, which presents as the bot going quiet rather than as an error (ADR 0015).
   * The client id is the one value we can check for free.
   */
  record(
    discord.DISCORD_CLIENT_ID === app.id ? "ok" : "fail",
    "DISCORD_CLIENT_ID belongs to the same application as the bot token",
    discord.DISCORD_CLIENT_ID === app.id
      ? `both are ${app.id}`
      : `.env says ${discord.DISCORD_CLIENT_ID}, but the token belongs to ${app.id}. The four Discord values must all come from ONE application, or Phase 5 dies silently.`,
  );

  // ---------------------------------------------------------------- OAuth redirect

  const expectedRedirect = `${web.PUBLIC_BASE_URL}/api/auth/callback/discord`;
  const registered = app.redirect_uris ?? [];

  record(
    registered.includes(expectedRedirect) ? "ok" : "fail",
    "OAuth redirect URI is registered",
    registered.includes(expectedRedirect)
      ? expectedRedirect
      : `expected ${expectedRedirect}\n     registered: ${
        registered.length ? registered.join(", ") : "(none)"
      }\n     Without it the login fails at Discord's end, so nothing appears in our logs.`,
  );

  // ---------------------------------------------------------------- the guild

  const guild = await discordJson<
    { id: string; name: string; owner_id: string }
  >(
    auth,
    `/guilds/${guildId}`,
  );
  record("ok", "The bot can see the guild", `"${guild.name}" (${guild.id})`);

  const roles = await discordJson<Role[]>(auth, `/guilds/${guildId}/roles`);
  const botMember = await discordJson<{ roles: string[] }>(
    auth,
    `/guilds/${guildId}/members/${app.bot!.id}`,
  );

  // ---------------------------------------------------------------- GUILD_MEMBERS intent

  /**
   * The authoritative probe. Discord's reference attaches the intent requirement
   * to *List* Guild Members, which is this call, and it is what Phase 4's poll
   * uses. A 403 here means the intent is off.
   *
   * The application's own flags are the secondary signal: they say *why*, and
   * they distinguish "approved" from "limited" (a bot in under 100 servers gets
   * the LIMITED bit, not the plain one).
   */
  const memberListProbe = await fetch(
    `https://discord.com/api/v10/guilds/${guildId}/members?limit=1`,
    { headers: { Authorization: `Bot ${discord.DISCORD_BOT_TOKEN}` } },
  );

  const flags = app.flags ?? 0;
  const flagged = Boolean(
    flags & (GATEWAY_GUILD_MEMBERS | GATEWAY_GUILD_MEMBERS_LIMITED),
  );

  record(
    memberListProbe.ok ? "ok" : "fail",
    "GUILD_MEMBERS privileged intent is enabled",
    memberListProbe.ok
      ? `the REST member list works (application flags ${
        flagged
          ? "agree"
          : "do not show it, but the call works, which is what matters"
      })`
      : `GET /guilds/{id}/members returned ${memberListProbe.status}. This is an APPLICATION TOGGLE (Developer Portal -> Bot -> Privileged Gateway Intents -> Server Members Intent), not a guild permission: no amount of permission substitutes for it, Administrator included. Phase 4's role sync will quietly do nothing without it.`,
  );

  // ---------------------------------------------------------------- role hierarchy

  const byId = new Map(roles.map((r) => [r.id, r]));
  const botRoles = botMember.roles.map((id) => byId.get(id)).filter(
    Boolean,
  ) as Role[];
  const botTop = botRoles.reduce(
    (best, r) => (r.position > best ? r.position : best),
    0,
  );

  /**
   * Officer and NCO are hand-assigned by the people who hold them, on purpose,
   * and `7R_Bot` cannot be raised above them (raising a role requires holding one
   * above it). So they are NOT in the set the bot must outrank: a bot that cannot
   * promote somebody to Officer is the unit's stated intent, not a defect
   * (ARCHITECTURE §7).
   *
   * What actually matters: Phase 4's sync only ever *reads* Discord roles and
   * writes TeamSpeak, so hierarchy does not touch it at all. Hierarchy binds only
   * the roles we WRITE: the badges, the staff roles, and the lower ranks.
   *
   * Strictly greater, never "at least". Equal positions are legal in Discord and
   * are broken by id, in a direction the docs do not specify. A tie is not a pass.
   */
  const HAND_ASSIGNED = ["Officer", "NCO"];

  const mustOutrank = [
    ...KNOWN_ASSIGNABLES
      .filter((a) => !HAND_ASSIGNED.includes(a.name))
      .map((a) => byId.get(a.id))
      .filter(Boolean) as Role[],
    ...roles.filter((r) => badgeFromDisplayName(r.name) && !r.managed),
  ];

  const outranked = mustOutrank.filter((r) => r.position >= botTop);

  record(
    mustOutrank.length === 0
      ? "unknown"
      : outranked.length === 0
      ? "ok"
      : "fail",
    "7R_Bot outranks every Assignable role it must WRITE",
    outranked.length === 0
      ? `the bot's highest role is at position ${botTop}, above all ${mustOutrank.length} of the roles it writes. Officer and NCO sit above it, which is deliberate: they are hand-assigned, the sync never writes a Discord role, and new badge roles land below the bot by construction. The only cost is that Phase 5's /rank set cannot promote to or demote from those two.`
      : `the bot's highest role is at position ${botTop}, and it does NOT outrank: ${
        outranked.map((r) => `${r.name} (${r.position})`).join(", ")
      }\n     MANAGE_ROLES only writes roles BELOW the bot's own, and Administrator does not exempt it. Every write to these 403s while the bot looks perfectly healthy.`,
  );

  // ---------------------------------------------------------------- permissions

  const everyone = byId.get(guildId); // the @everyone role's id IS the guild id
  let permissions = BigInt(everyone?.permissions ?? "0");
  for (const role of botRoles) permissions |= BigInt(role.permissions);

  const isAdmin = (permissions & ADMINISTRATOR) !== 0n;
  const has = (bit: bigint) => isAdmin || (permissions & bit) !== 0n;

  record(
    isAdmin ? "warn" : has(MANAGE_ROLES) && has(CREATE_EVENTS) ? "ok" : "fail",
    "7R_Bot's permissions",
    isAdmin
      ? "still ADMINISTRATOR. Nothing is blocked by it, so this is hygiene, not a bug: but the token now lives in a .env on a box we do not own, and Administrator turns a leaked token into a lost guild. Dial it back to CREATE_EVENTS + MANAGE_ROLES, and do it LAST: after the badge roles exist, after the hierarchy is fixed, and after the memes are harvested."
      : `MANAGE_ROLES=${has(MANAGE_ROLES)} CREATE_EVENTS=${
        has(CREATE_EVENTS)
      } MANAGE_EVENTS=${
        has(MANAGE_EVENTS)
      }\n     CREATE_EVENTS (1<<44) is the one that matters: MANAGE_EVENTS (1<<33) only edits events that already exist and 403s on create.`,
  );

  // ---------------------------------------------------------------- the Assignable roles

  const missingAssignables = KNOWN_ASSIGNABLES.filter((a) => !byId.has(a.id));
  record(
    missingAssignables.length === 0 ? "ok" : "warn",
    "The 8 rank/role Discord ids from the legacy dump still exist",
    missingAssignables.length === 0
      ? "all 5 ranks and 3 roles found in the guild"
      : `not in the guild: ${
        missingAssignables.map((a) => `${a.name} (${a.id})`).join(", ")
      }\n     These ids come from a 2019 dump. A role that was deleted and recreated has a new id, so Phase 4 would seed an Assignable that matches nobody, silently. Nobody had checked these.`,
  );

  // Match by canonical badge recovered from the display name, so an emoji-bearing
  // "🎖️ Medic" counts as found rather than reporting all 8 missing.
  const presentBadges = new Set(
    roles
      .filter((r) => !r.managed)
      .map((r) => badgeFromDisplayName(r.name))
      .filter(Boolean),
  );
  const foundBadges = BADGE_NAMES.filter((name) => presentBadges.has(name));

  record(
    foundBadges.length === BADGE_NAMES.length ? "ok" : "fail",
    "The 8 badge roles exist in Discord",
    foundBadges.length === BADGE_NAMES.length
      ? "all 8 found"
      : `missing: ${
        BADGE_NAMES.filter((b) => !foundBadges.includes(b)).join(", ")
      }\n     Badges only ever existed as TeamSpeak groups. ADR 0002 makes Discord authoritative for every Assignable, so until these exist, 8 of the 16 Assignables can never sync. Run \`deno task badges:backfill\` (dry-run first): it creates them below 7R_Bot, mirrors the live TeamSpeak groups, and prints the ids for docs/MIGRATION.md.`,
  );

  // ---------------------------------------------------------------- surviving /loa

  const globalCommands = await discordJson<{ name: string }[]>(
    auth,
    `/applications/${app.id}/commands`,
  );
  const guildCommands = await discordJson<{ name: string }[]>(
    auth,
    `/applications/${app.id}/guilds/${guildId}/commands`,
  );

  const globalLoa = globalCommands.some((c) => c.name === "loa");
  const guildLoa = guildCommands.some((c) => c.name === "loa");

  record(
    globalLoa ? "warn" : "ok",
    "No surviving GLOBAL /loa on this application",
    globalLoa
      ? "a GLOBAL /loa is registered. Phase 5's bulk PUT replaces only the scope it targets, so a global command SURVIVES it, and once the interactions URL points at us it is routed to an endpoint with no handler behind it. Delete it explicitly."
      : `global commands: ${
        globalCommands.map((c) => `/${c.name}`).join(", ") || "(none)"
      }`,
  );

  record(
    "ok",
    "Guild-scoped commands (a /loa here dies for free in Phase 5)",
    `${guildCommands.map((c) => `/${c.name}`).join(", ") || "(none)"}${
      guildLoa ? "  <- /loa present, but Phase 5's bulk PUT removes it" : ""
    }`,
  );
}

const ICON: Record<Status, string> = {
  ok: "  OK  ",
  warn: " WARN ",
  fail: " FAIL ",
  unknown: "  ??  ",
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error("\nPreflight could not complete:\n", error);
    console.error(
      "\nIf that was a 401, the bot token is wrong. If it was a 404 on the guild, the bot is not in it.",
    );
    Deno.exit(1);
  }

  console.log("\n7R_Bot Phase 0 preflight\n");
  for (const { status, title, detail } of results) {
    console.log(`[${ICON[status]}] ${title}`);
    console.log(`     ${detail}\n`);
  }

  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;

  console.log(
    failed === 0
      ? `Nothing is failing. ${warned} warning(s).`
      : `${failed} check(s) FAILED, ${warned} warning(s).`,
  );
  console.log(
    "\nNot checked here (they are not Discord's to answer):" +
      "\n  - the public origin: nginx must front the web container and terminate TLS" +
      "\n  - the TeamSpeak ServerQuery login: `docker compose ps` (the worker dies without it)" +
      "\n  - the legacy dump on the box at <deploy>/data/Dump20260711.sql" +
      "\n  - the meme harvest, and whether 7R_Bot can even re-sign attachments it did not post",
  );

  Deno.exit(failed === 0 ? 0 : 1);
}
