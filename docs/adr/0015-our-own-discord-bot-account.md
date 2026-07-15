# The platform runs as its own Discord bot account (`7R_Bot`)

The commands are ported from `joeyyyb/7r-discordbot`. The account is not. The platform authenticates as **`7R_Bot`**, a Discord application under the unit's own control, already present in the guild, previously the bot behind the old `/loa`. `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` all come from it. The 2019 bot's token is never used, never enters this repo, and needs no rotation from us.

This reverses what ARCHITECTURE §7 and ADR 0014 previously said ("reuse the token"), which is why it is written down rather than quietly edited away.

## Why

The 2019 credential belongs to an application we do not own, and it sits in the git history of someone else's repo, readable by everyone with access to it. Reusing it would weld the platform to a shared secret that we cannot rotate unilaterally: to change it, we would have to ask, and the legacy bot that still runs on that same token would break the moment anyone did. That is the opposite of what ADR 0014 is trying to buy, which is a credential cheap enough to rotate that someone actually rotates it.

Owning the account collapses that. Rotation becomes one line of `.env` and a restart. Nothing in Phase 0 waits on someone else handing a secret over. And because the two bots are now genuinely separate accounts on separate tokens, the legacy bot is not something we cut over from at an instant: it keeps its own credential, keeps running, and gets retired whenever it suits.

The switch is close to free. `7R_Bot` already exists and is already in the guild, so there is no invite to send and no new application to create.

## Considered and rejected

- **Reuse the 2019 account.** What the docs said until now. It works, and the token was never leaked (ARCHITECTURE §7), so this was never a security emergency. Rejected on ownership, not on risk: it inherits a credential several other people can read, on an application we cannot administer, and it couples our deploy to a bot we do not control.
- **Create a third, brand-new application.** Clean, and the obvious move if `7R_Bot` did not exist. It does exist, it is already in the guild, and it already carries the `applications.commands` scope, so a new app would buy an invite flow and a fresh set of ids for nothing.

## Consequences

- **All four Discord values come from one application.** A bot token from one and a public key from another is a 401 on every interaction, after which Discord removes the endpoint URL: silent, delayed bot death (ADR 0003). This is now reachable by a single wrong line in `.env`, so `.env.example` says so.
- **Phase 0 gains real work.** It used to be a no-op confirmation of a reused app. It is now: collect the four values; enable the **GUILD_MEMBERS** privileged intent; move `7R_Bot`'s role above every Assignable role; dial its permissions back; clear any surviving `/loa`.
- **`7R_Bot` holds Administrator today**, left over from `/loa`. That covers `CREATE_EVENTS` + `MANAGE_ROLES` and everything else besides, so nothing is blocked, but its token now lives in a `.env` on a box we do not own (ADR 0005), and Administrator turns a leaked token into a lost guild. ARCHITECTURE §7 wants it dialled back to those two permissions.
- **Two things permissions do not buy.** The GUILD_MEMBERS intent is an *application* toggle, not a permission, and Administrator does not imply it; without it the REST member list is refused and Phase 4 (the sync) quietly does nothing. And **role hierarchy is not bypassed by Administrator**: `MANAGE_ROLES` only writes roles below the bot's own, so `7R_Bot`'s role must outrank every rank, role and badge role, including the 8 badge roles Phase 0 creates. Both failures are silent.
- **The account is adopted; `/loa` is not.** This system has no Leave of Absence (ADR 0010). Registering our commands is a bulk overwrite that drops a guild-scoped `/loa` for free; a *global* one would survive and be routed at our endpoint with no handler behind it, so list before registering.
- **No cutover instant.** The legacy bot keeps its token and its `!` prefix commands, which cannot collide with slash commands. It can be retired lazily.
- **ADR 0014's reuse bullet is superseded**; its warning about never letting the 2019 token into this repo survives, and applies to the legacy token exactly as before.
- **A naming collision now exists.** `7R_Bot` is the Discord application. `7R Bot` (`TS_BOT_NICKNAME`) is the TeamSpeak ServerQuery client's nickname. Different systems, different things, and the nickname is not changing. See `CONTEXT.md`.
