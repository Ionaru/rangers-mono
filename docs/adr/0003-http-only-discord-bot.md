# The Discord bot is HTTP-only (no gateway connection)

The bot uses Discord's HTTP interactions endpoint for commands (Ed25519-verified webhooks) and the REST API for everything else (creating the weekly scheduled event, reading guild members for role sync, granting/removing roles). It holds no persistent gateway WebSocket. This keeps the whole platform on Deno.

## Why

Everything the unit asked for works over HTTP: slash-command memes, role grant/take, role inspection, weekly event creation, and Discord-to-TeamSpeak role sync (via periodic REST polling of guild members). A gateway connection would only add passive message-triggered memes, instant auto-role-on-join, and second-by-second sync. For a ~100-person unit, a few minutes of sync latency is fine, and basic auto-role-on-join is covered by Discord's native Onboarding.

A gateway would mean an always-on stateful process (connect, heartbeat, resume, reconnect) whose only job is to deliver features nobody asked for. HTTP-only has no such process: the interactions endpoint is just another route on the web app we already run, and the periodic REST jobs are plain scheduled work in the worker. There is no separate listener to keep alive.

One gateway-adjacent fact is worth recording: Discordeno, the Deno-native gateway option, is stale. Its last release is 21.0.0 from December 2024.

Calls go out over plain `fetch` (see ADR on dependency surface): at roughly one request every three minutes, a rate-limit-bucketing client buys nothing.

## Correction (July 2026)

The original justification for this ADR claimed that "the Discord-gateway-on-Deno path (discord.js over undici) is regression-prone and has broken on Deno as recently as 2025", and that "a gateway bot would have to run on Node to be reliable, splitting the runtime". That was checked and is no longer true:

- A live gateway connection opened from Deno 2.9.2 returned `op = 10 HELLO` using only the native `WebSocket`, with zero npm packages.
- denoland/deno#20761, the issue that claim rested on, was closed 2025-02-20.

The decision is unchanged, but it does not rest on that reason any more. It rests on the reasons above. Recorded here so nobody re-derives the stale argument, finds it false, and reopens a settled decision for the wrong cause.

## Considered and rejected

- **Gateway bot.** Gains passive memes and instant reactions, but adds an always-on stateful process and the operational surface we are trying to avoid. It is technically viable on Deno (see the correction above); it is simply not worth the process. Rejected for now; revisit only if passive memes or instant auto-role become genuinely wanted.

## Consequences

- All bot commands are application (slash) commands with per-role gating and ephemeral replies. Prefix (`!`) commands and passive "someone typed X" reactions are not available.
- The interactions endpoint is served by the website app itself, so the bot needs no separate public listener; only the background REST jobs (event creation, role sync) need a running worker.
- Role sync is eventually-consistent (poll interval), not real-time.
- **Signature verification must fail closed.** The Ed25519 check on the interactions endpoint returns 401 on any exception, never 200. Discord deliberately sends invalid signatures to test the endpoint, and will remove the interactions URL if it ever accepts one. That failure is silent and delayed: the bot just stops receiving commands. Verify over the raw request body bytes, never `JSON.parse` then re-stringify.
- Interactions must be answered within 3 seconds or acknowledged deferred (type 5). This matters on a cold container start.
