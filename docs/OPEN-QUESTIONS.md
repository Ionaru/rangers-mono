# Resolved questions log

All 16 open questions from the grilling are resolved. Kept as a record of what was decided and any residual action.

## Ownership, hosting, security

- **Q2 - Ownership.** You control the Discord app/guild (`305471712546390017`) and GHCR; **reuse all** (after rotating the token).
- **Q3 - Leaked token.** The `joeyyyb/7r-discordbot` repo is now private. **Action still required:** the token was public for ~7 years, so rotate it in the developer portal before reuse. Private repo does not un-leak it.
- **Q4 - Public reachability.** Yes. The box already runs an **nginx + Let's Encrypt** entrypoint reverse-proxying other containers; the new site slots in as an upstream. (Reverse-proxy plan changed from Caddy to reusing this.)
- **Q5 - Docker.** **Docker Desktop** (Linux containers).

## Data & roles

- **Q1 - Legacy DB.** **Retrievable.** Import Discord<->TeamSpeak links + rank/role/badge definitions; also import historical attendance (same TS-presence mechanism, so comparable).
- **Q8 - Rank structure.** Unchanged: Recruit -> Member -> NCO -> Officer, plus role (job) and badge (qualification) groups.
- **Q6 - TS control.** **Full control** (query login + IP allowlist available).
- **Q10 - Linking mechanic.** Users can message the query bot but **can't see it** without an obscure setting. Resolved by making it bot-initiated: pick-self-from-list, the bot pokes a code, member types it back. (Superseded the PM-a-code flow.)

## TeamSpeak future & Arma

- **Q15 - TS3 vs TS6.** **Stay on TS3**, transport behind a swappable interface.
- **Q11 - Engine future.** **Staying on Arma 3.** (No longer affects attendance, which is TS-based.)
- **Q7 - Op window.** Mission time **20:00-23:00** Europe/Amsterdam; Discord event to **23:30** (overtime/debrief). Attendance window is 20:00-23:00.
- **Q12 - Attendance threshold.** **60 minutes** of in-window presence.

## Attendance approach change

- Attendance now comes from **TeamSpeak Operations-channel presence** (ADR 0007), not the Arma server (ADR 0004 superseded). One Operations channel (ACRE2 handles squad comms). Steam/Arma kept only for **roster completeness & vetting**.

## Content & ops

- **Q13 - Meme images.** Not dead: the old bot still runs and serves them. **Harvest and re-host now** while the URLs are live.
- **Q14 - Handbook.** Migrate the current 21 files **and restore** the dropped sections (FAQ, Loadouts, Formations, Extended handbook), after a content sanity-check.
- **Q9 - Loadout Sheet.** **Keep external** (linked from the handbook).
- **Q16 - Backup bus-factor.** **Deferred to Phase 7** (document restore + arrange a second key-holder then).
