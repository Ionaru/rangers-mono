# The Discord bot is HTTP-only (no gateway connection)

The bot uses Discord's HTTP interactions endpoint for commands (Ed25519-verified webhooks) and the REST API for everything else (creating the weekly scheduled event, reading guild members for role sync, granting/removing roles). It holds no persistent gateway WebSocket. This keeps the whole platform on Deno.

## Why

Everything the unit asked for works over HTTP: slash-command memes, role grant/take, role inspection, weekly event creation, and Discord-to-TeamSpeak role sync (via periodic REST polling of guild members). A gateway connection would only add passive message-triggered memes, instant auto-role-on-join, and second-by-second sync. For a ~100-person unit, a few minutes of sync latency is fine, and basic auto-role-on-join is covered by Discord's native Onboarding.

The decisive cost avoided: the Discord-gateway-on-Deno path (discord.js over undici) is regression-prone and has broken on Deno as recently as 2025; Discordeno (the Deno-native option) has no stable release since late 2024. A gateway bot would have to run on Node to be reliable, splitting the runtime. HTTP-only keeps everything on Deno with plain `fetch` + `@discordjs/rest`.

## Considered and rejected

- **Gateway bot on Node.** Gains passive memes and instant reactions, but adds an always-on process, a second runtime, and the operational surface we are trying to avoid. Rejected for now; revisit only if passive memes or instant auto-role become genuinely wanted.

## Consequences

- All bot commands are application (slash) commands with per-role gating and ephemeral replies. Prefix (`!`) commands and passive "someone typed X" reactions are not available.
- The interactions endpoint can be served by the website app itself, so the bot may not need a separate public listener; only the background REST jobs (event creation, role sync) need a running worker.
- Role sync is eventually-consistent (poll interval), not real-time.
