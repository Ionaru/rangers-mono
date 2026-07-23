import { getDiscordConfig, loadAll } from "@7r/config";
import type { DiscordConfig } from "@7r/config";
import { discordJson, type DiscordRestOptions } from "./rest.ts";
import { type CommandDefinition, LINK_COMMANDS } from "./commands.ts";

/**
 * Register `7R_Bot`'s slash commands.
 *
 *   deno task commands:register                    # prints both scopes, writes nothing
 *   deno task commands:register -- --apply         # asks, then bulk-PUTs the guild scope
 *   deno task commands:register -- --apply --clear-global  # also clears global
 *
 * Two things here are destructive, and neither is reversible by re-running, so
 * the default is read-only and the write is confirmed at the terminal (there is
 * no admin UI: ADR 0009).
 *
 * **A bulk PUT replaces the entire scope it targets.** Registering the guild
 * scope drops any surviving guild-scoped `/loa` for free, which is what we want
 * (there is no LOA in this system: ADR 0010). It writes GUILD-scoped, not
 * global: guild commands propagate instantly, and a stale command can be cleared
 * by the same bulk PUT. A *global* `/loa` cannot be cleared by a guild PUT and
 * would survive to be routed at our endpoint with no handler behind it, so this
 * lists the global scope too and refuses to touch it without `--clear-global`.
 *
 * Application id is `DISCORD_CLIENT_ID` (the schema says so: one application
 * serves OAuth login and command registration).
 */

interface RegisteredCommand {
  id: string;
  name: string;
  description: string;
  type: number;
}

function listGlobal(
  auth: DiscordRestOptions,
  appId: string,
): Promise<RegisteredCommand[]> {
  return discordJson<RegisteredCommand[]>(
    auth,
    `/applications/${appId}/commands`,
  );
}

function listGuild(
  auth: DiscordRestOptions,
  appId: string,
  guildId: string,
): Promise<RegisteredCommand[]> {
  return discordJson<RegisteredCommand[]>(
    auth,
    `/applications/${appId}/guilds/${guildId}/commands`,
  );
}

function names(commands: { name: string }[]): string {
  return commands.length === 0
    ? "(none)"
    : commands.map((c) => `/${c.name}`).join(", ");
}

async function main(): Promise<number> {
  const apply = Deno.args.includes("--apply");
  const clearGlobal = Deno.args.includes("--clear-global");

  const [discord] = loadAll<[DiscordConfig]>([getDiscordConfig]);
  const appId = discord.DISCORD_CLIENT_ID;
  const guildId = discord.DISCORD_GUILD_ID;
  const auth: DiscordRestOptions = { botToken: discord.DISCORD_BOT_TOKEN };

  // ------------------------------------------------ what is registered now

  const [globalNow, guildNow] = await Promise.all([
    listGlobal(auth, appId),
    listGuild(auth, appId, guildId),
  ]);

  console.log("currently registered:");
  console.log(`  global : ${names(globalNow)}`);
  console.log(`  guild  : ${names(guildNow)}`);
  console.log();
  console.log("this will PUT the guild scope to:");
  console.log(`  guild  : ${names(LINK_COMMANDS)}`);

  const droppedFromGuild = guildNow
    .filter((c) => !LINK_COMMANDS.some((k) => k.name === c.name))
    .map((c) => `/${c.name}`);
  if (droppedFromGuild.length > 0) {
    console.log(
      `\n  the bulk PUT DROPS from the guild scope: ${
        droppedFromGuild.join(", ")
      }`,
    );
  }

  if (globalNow.length > 0) {
    console.log(
      `\nNOTE: ${globalNow.length} GLOBAL command(s) exist: ${
        names(globalNow)
      }.` +
        "\n  A guild PUT cannot touch them. If a stale /loa is global, re-run with" +
        "\n  --clear-global to wipe the global scope as well.",
    );
  }

  if (!apply) {
    console.log(
      "\n--- dry run. Nothing was registered. Pass --apply to do it. ---",
    );
    return 0;
  }

  // ------------------------------------------------ confirm, then write

  // confirm() needs a TTY; a headless run answers "no" and writes nothing, which
  // is the right default for a destructive action a human is meant to review.
  if (!confirm("\nApply this registration?")) {
    console.log("Not confirmed. Nothing was registered.");
    return 0;
  }

  await putGuild(auth, appId, guildId, LINK_COMMANDS);
  console.log(
    `\nRegistered ${LINK_COMMANDS.length} guild command(s): ${
      names(LINK_COMMANDS)
    }.`,
  );

  if (clearGlobal) {
    await putGlobal(auth, appId, []);
    console.log("Cleared the global command scope.");
  }

  console.log(
    "\nNext: set the Interactions Endpoint URL on the 7R_Bot application to" +
      "\n  <PUBLIC_BASE_URL>/api/discord/interactions" +
      "\n  Discord PINGs it and refuses to save unless the signature check passes.",
  );
  return 0;
}

function putGuild(
  auth: DiscordRestOptions,
  appId: string,
  guildId: string,
  commands: CommandDefinition[],
): Promise<unknown> {
  return discordJson(
    auth,
    `/applications/${appId}/guilds/${guildId}/commands`,
    { method: "PUT", body: JSON.stringify(commands) },
  );
}

function putGlobal(
  auth: DiscordRestOptions,
  appId: string,
  commands: CommandDefinition[],
): Promise<unknown> {
  return discordJson(auth, `/applications/${appId}/commands`, {
    method: "PUT",
    body: JSON.stringify(commands),
  });
}

if (import.meta.main) {
  const code = await main();
  if (code > 0) Deno.exit(code);
}
