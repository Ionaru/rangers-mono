# 7R Platform: Architecture & Build Plan

The rebuild of the 7th Ranger Group's software: a public website (info, handbook, briefing generator), a Discord bot, TeamSpeak role sync, and op-attendance tracking, tied together by a verified identity per member.

This document is the plan (the *what* and *why*). Architectural decisions are in `docs/adr/`; terminology is in `CONTEXT.md`; every open question from the grilling is resolved in `docs/OPEN-QUESTIONS.md`. For the *how* (config, data-model DDL, sync/link/attendance mechanics) see `docs/IMPLEMENTATION.md`, and for the legacy data import see `docs/MIGRATION.md`.

---

## 1. Decisions at a glance

| Area | Decision | Ref |
|---|---|---|
| Identity | Discord is the hub and the site's only login; TeamSpeak and Steam link onto it | ADR 0001 |
| Roles | Discord roles are the source of truth; TeamSpeak is synced one-way from them | ADR 0002 |
| Role sync | Full reconcile, scoped to the mapping; unmapped TS groups (Server Admin, etc.) always persist; dry-run before first sync | ADR 0002 |
| Admin surface | No admin web UI: git-config mapping, admin slash commands (`/link-force`, guest-claim), CLI sync preview, read-only views only | ADR 0009 |
| Bot | HTTP-only (interactions + REST), no gateway, all-Deno; all commands are slash commands | ADR 0003 |
| **Attendance** | **Sample the single TeamSpeak Operations channel during the op window; no Arma integration** | **ADR 0007** |
| Deployment | One Windows box (the game server), Docker Desktop, behind its existing nginx + Let's Encrypt proxy | ADR 0005 |
| Repo/runtime | One monorepo, Deno 2 + native workspaces, no Nx; Astro is a package.json member | ADR 0006 |
| Database | PostgreSQL in Docker; Drizzle ORM + drizzle-kit | ADR 0008 |
| Website | Public static content + Discord-authed member area; handbook is Markdown in the repo | this doc |
| Briefing generator | Stateless client-side tool that emits SQF (optionally shareable via URL) | this doc |
| Steam link | Exactly one per member, verified by Steam OpenID; used for roster/vetting only | this doc |
| TeamSpeak link | One at a time, self-service; proven by picking self from the online-clients list and typing back a code the bot pokes | this doc |
| Ops | The auto-created weekly Discord scheduled event *is* the Operation | this doc |
| Force-link | Admins may manually link, flagged as unverified | this doc |

Confirmed unit facts: TeamSpeak is primary voice; the Arma server is self-hosted Windows with full access but **BattlEye off**; ops are Saturday, mission time **20:00-23:00** Europe/Amsterdam (Discord event to 23:30); one Operations channel (ACRE2 handles squad comms); rank ladder Recruit/Member/NCO/Officer; the legacy MySQL DB is retrievable; the box already runs Docker + nginx + Let's Encrypt; staying on TS3 and Arma 3.

---

## 2. System architecture

Three containers added behind the existing nginx on one Windows host, plus the unchanged external TeamSpeak and Discord:

```
                    ┌───────────────────────── Windows box (Docker Desktop) ─────────────────────────┐
                    │                                                                                 │
 Internet ─443─▶ ┌───────────────┐        ┌───────────────┐          ┌───────────────┐                │
                 │ nginx + LE    │──────▶ │  web (Astro   │─────────▶│   postgres    │◀──────┐        │
                 │ (existing)    │        │  SSR, Deno)   │          │  (Docker vol) │       │        │
                 └───────────────┘        └──────┬────────┘          └───────┬───────┘       │        │
                        ▲                        │ shares DB                 │ shares DB     │        │
 Discord interactions ──┘                        │                          │               │        │
 (Ed25519 webhook) ─────────────▶ /api/discord/interactions                 │               │        │
                                                                            │               │        │
                                        ┌───────────────┐  ServerQuery      │               │        │
                                        │    worker     │──(ssh:10022)──▶ TeamSpeak (extern) │        │
                                        │    (Deno)     │──Discord REST──▶ Discord API       │        │
                                        └───────────────┘                                    │        │
                    │                    (samples Operations channel; syncs roles;           │        │
                    │                     creates weekly event; verifies links)              │        │
                    └─────────────────────────────────────────────────────────────────────────────────┘
```

- **nginx + Let's Encrypt (existing)** — reverse proxy already on the box; the new `web` service is added as an upstream. TLS already solved.
- **web** — Astro 7 SSR on Deno. Public site (static/prerendered), Discord-authed member area, Discord OAuth login (Better Auth), Steam OpenID linking, and the Discord **interactions endpoint** (`/api/discord/interactions`, Ed25519-verified) handling all slash commands.
- **worker** — one long-running Deno process holding: the TeamSpeak ServerQuery connection (link verification + group reconcile + attendance sampling), and scheduled Discord REST jobs (create the weekly event, poll members and sync roles to TS).
- **postgres** — the durable state web and worker share (identity links, role mapping, operations, attendance, link codes, auth/session tables).

The worker and web are separate processes (worker runs continuously on timers and a persistent TS connection; web is request/response) but one repo sharing the domain and DB packages, which is the coupling that justifies the monorepo (ADR 0006).

---

## 3. Data model

PostgreSQL. Sketch (columns illustrative):

**member** — the person / hub.
- `id`, `discord_id` (unique, **required**), `display_name`, `disabled_at`, timestamps
- TeamSpeak (one current, replaceable): `ts_uid` (unique, nullable), `ts_verified_at`, `ts_link_method` (`poke` | `manual`)
- Steam (exactly one, roster/vetting): `steam_id` (unique, nullable), `steam_verified_at`, `steam_link_method` (`openid` | `manual`)
- `manual` link method is the admin force-link flag (marks a link as not self-verified).

**assignable** — a rank / role / badge and its mapping.
- `id`, `kind` (`rank` | `role` | `badge`), `name`, `discord_role_id` (unique), `ts_sgid` (nullable), `category`, `sort_order`
- The set of non-null `ts_sgid` is the "owned set" the sync reconciles; everything else on TS is left alone.

**operation** — one op.
- `id`, `date`, `attendance_start` (20:00), `attendance_end` (23:00), `event_end` (23:30), `discord_event_id`, `name`, `source` (`auto_weekly` | `manual`)
- The weekly job creates the Discord scheduled event and this row together.

**attendance_session** — one continuous presence span in the Operations channel.
- `id`, `operation_id`, `member_id` (**nullable** = guest), `ts_uid` (raw sampled), `ts_nickname`, `joined_at`, `left_at`
- Reconstructed from periodic samples of the Operations channel. Credit is derived: a member is credited if the sum of in-window session minutes >= 60. Guests (unlinked ts_uid) are surfaced for claiming.

**link_code** — one-time TeamSpeak possession challenge.
- `id`, `code`, `member_id`, `target_ts_uid` (the client the member picked, that the bot pokes), `expires_at`, `consumed_at`
- Steam uses OpenID and needs no code.

**Auth/session tables** — owned by Better Auth; Astro sessions stored in Postgres via unstorage (on Deno there is no auto session store, so this is explicit or logins break).

Fixes vs the legacy: operations are real rows with real windows; attendance still keys on the TeamSpeak identity (as before) but now resolves through the `member` hub; demotions propagate; Steam is actually wired up (for roster/vetting).

---

## 4. Subsystems

### 4.1 Website (`apps/web`, Astro 7 on Deno)

- **Public, static/prerendered:** landing/recruitment, about, handbook, briefing generator.
- **Handbook:** Starlight + `starlight-versions`, Markdown in `content/handbook/` (migrate the current 21 files, ~31k words, ~100 diagrams, **and restore the older dropped sections** FAQ / Loadouts / Formations / Extended handbook, after a content sanity-check). Edited via GitHub/PR. The loadout Google Sheet stays external (linked from the handbook).
- **Briefing generator:** a hydrated island (Preact/Svelte, decide in the web spike) reproducing the current tool's SQF output **byte-for-byte** (`createDiaryRecord` blocks in reverse insertion order). Stateless: fill in, copy the SQF, optionally share via a URL that encodes the inputs. No backend.
- **Member area (SSR, Discord-authed):** your profile (Discord + linked TeamSpeak + linked Steam), link/unlink TeamSpeak and Steam, view your own attendance, and a read-only roster/vetting view (who has linked/verified). There is **no admin web panel** (ADR 0009): the Assignable mapping is git-config, force-link and guest-claim are admin slash commands, and the sync dry-run is a CLI task.
- **Auth:** Better Auth with the Discord social provider (Lucia is deprecated). Sessions in Postgres.
- **Discord interactions endpoint:** `/api/discord/interactions`, Ed25519 verified with WebCrypto. The bot needs no separate public listener.

### 4.2 Discord bot (HTTP-only)

Commands handled by the web interactions endpoint; scheduled writes run in the worker.
- **Memes:** ported from `fun.py` (20 image+caption pairs, the "slav" set, `!ff`/`!monkey`/`!medic`/`!8ball`/`!rps`, the `!slotting` squad-dealer), now slash commands with ephemeral replies and per-role gating. The images are still live on the running old bot; harvest and re-host them into the repo now, before anything changes.
- **Role inspection:** "who has role X", "what roles does @user have", "who is missing role Y", roster export. Reads members via REST (GUILD_MEMBERS intent).
- **Role grant/take:** admin-gated slash commands, honoring the role-hierarchy rule and writing audit-log reasons.
- **Weekly event (worker job):** idempotently create the Saturday event (`POST /guilds/{id}/scheduled-events`, EXTERNAL, location = TeamSpeak/server; Manage Events). Event window 20:00-23:30 Europe/Amsterdam, DST-correct (compute real local time). Creating the event creates the Operation row (attendance window 20:00-23:00).

### 4.3 Identity linking

One Member, verified across three namespaces:
- **Discord** — proven by the OAuth login itself (the hub).
- **TeamSpeak** — possession challenge, bot-initiated (members can't see the query bot to message it): the member, connected to TeamSpeak, opens "link TeamSpeak"; the site shows the currently-online, unlinked TS clients (usually just them); the member picks themselves; the worker pokes that client a one-time code; the member types the code back on the site to confirm. One current link, self-service replaceable.
- **Steam** — Steam OpenID ("Sign in through Steam", live in 2026, ~60 lines direct). Proves account ownership (this is the vetting) and yields the SteamID64, stored for the roster. No Arma-side use.

### 4.4 Role sync (Discord -> TeamSpeak, worker)

- Poll guild members via REST every few minutes. For each member with a linked `ts_uid`, compute desired TS server-groups from their Discord roles via the `assignable` mapping.
- Reconcile using the legacy `rangers-site` three-way algorithm: assign missing owned groups, remove owned groups they no longer qualify for, **never touch groups outside the owned set**. Operate on `cldbid` (resolved via `clientgetdbidfromuid`).
- ServerQuery via `ts3-nodejs-library` (npm:), SSH transport (port 10022). You have full TS control, so create a query login and IP-allowlist the bot (lifts the 10-cmd/3s throttle).
- First run is a **dry-run** via the `deno task sync:preview` CLI task before any writes (ADR 0009).

### 4.5 Operations & attendance (worker)

- **The weekly job** creates the Discord event + Operation (§4.2).
- **Sampling:** during the attendance window (20:00-23:00 Europe/Amsterdam), the worker polls the single **Operations channel** membership via ServerQuery (`clientList({ cid })`) roughly every 1-2 minutes, recording which TS UIDs are present.
- **Reconstruction:** diff consecutive samples into `attendance_session` join/leave spans per TS identity (the legacy diffing approach). Resolve `ts_uid` -> member; unmatched = guest.
- **Credit:** sum in-window minutes per member; credited if >= 60. Close any dangling session at the window's end.
- No Arma server connection, no framework changes, no log parsing, no A2S.

---

## 5. Repo layout

```
rangers-mono-v2/
  deno.json                 # workspace members, tasks, single lockfile
  docker-compose.yml        # web + worker + postgres (nginx already on the host)
  CONTEXT.md                # glossary
  docs/
    ARCHITECTURE.md         # this file
    OPEN-QUESTIONS.md       # resolved-question log
    adr/                    # 0001..0007
  packages/
    config/                 # env parsing, fails loud at boot
    domain/                 # Member, Operation, Assignable, attendance rules; zero I/O
    db/                     # Drizzle schema + drizzle-kit migrations + queries (ADR 0008)
    discord/                # REST wrappers, Ed25519 verify, command definitions
    teamspeak/              # ServerQuery client, group reconcile (ported), channel sampling, poke-link
    identity/               # linking logic, link codes
  apps/
    web/                    # Astro 7 (package.json member)
    worker/                 # Deno long-running process
  content/
    handbook/               # Markdown + images (migrated + restored sections)
```

Two survival rules in the worker: an `unhandledrejection` handler that logs and continues (Deno kills the process by default; a stray error must not drop the TS connection), and it should recover/reconnect the ServerQuery connection cleanly (reuse the legacy's `removeAllListeners` reconnect guard).

---

## 6. Deployment & operations

- **Docker Desktop** on the Windows box; new services behind the **existing nginx + Let's Encrypt** proxy (add `web` as an upstream). Postgres on a Docker-managed volume.
- Turn on `json-file` **log rotation** (Docker does none by default; a chatty container can fill the disk under the game server). Set container CPU/memory limits and watch server FPS during the first ops (ADR 0005).
- **Secrets:** Compose file-based `secrets:` for DB password, Discord bot token, TS query password, session key. Not committed, not in images.
- **Backups:** nightly `pg_dump -Fc` + `restic` to off-box storage, with a restore drill. The identity links are the one thing that cannot be rebuilt. Second key-holder deferred to Phase 7.
- **CI/CD:** GitHub Actions -> build images to GHCR (reuse the existing namespace) -> deploy by `docker compose pull && up -d` over SSH, pinned to a commit SHA. No Watchtower on our own images.
- **Observability:** the worker posts its own errors to a private Discord channel.

---

## 7. Security (act before/independent of the build)

- **Rotate the leaked 2019 bot token.** The repo is now private, but the token was public for ~7 years, so making the repo private does **not** un-leak it. Rotate it in the Discord developer portal before reusing that application. The Arma server password (`orbs`) must also no longer be printed by any command (the old `!server` leaked it).
- **Least privilege** for the bot: Manage Roles, Manage Events, GUILD_MEMBERS intent. Nothing more.
- **Privacy (EU unit, GDPR-lite):** store only `discord_id`, `ts_uid`, `steam_id`, display names, attendance timestamps. Let members self-unlink and request deletion. Document retention.

---

## 8. What we carry over from the old code

- **Steal:** the `rangers-site` TeamSpeak three-way reconcile (`teamspeak.service.ts`), its reconnect guard, and its `record-operation-attendees` channel-sampling + diffing (now the core of attendance); the identity-hub shape; the Assignable idea (rank/role/badge). The `rangers-mono` handbook content + the briefing generator's exact SQF template. The `fun.py` meme content and `!slotting` algorithm (images harvested from the still-running bot).
- **Bin:** EOL toolchains, the Nx build, discord.py 1.3.4, leaked-secret plumbing, the add-only Discord sync, the empty legacy OperationModel.
- **Migrate from the legacy DB (retrievable):** import the curated Discord<->TeamSpeak links and the rank/role/badge -> Discord-role/TS-group definitions (seeds the `assignable` mapping and `member.ts_uid`, marked for re-verification). Steam was never populated (nothing to import). Because legacy attendance used the **same** TS-channel-presence mechanism, **historical attendance is comparable and can be imported** as real op history.

---

## 9. Phased build plan

- **Phase 0 - Prep (no code):** rotate the leaked token; confirm the reused Discord app/guild/GHCR; **harvest the meme images from the running bot**; export the legacy DB.
- **Phase 1 - Foundation:** monorepo skeleton (deno.json workspaces), `config`, `domain`, `db` (schema + migrations), Compose with Postgres, add `web` upstream to nginx, CI->GHCR.
- **Phase 2 - Public site:** Astro app, branding, handbook (Starlight; migrate 21 files + restore dropped sections after review; link the loadout Sheet), stateless briefing generator (SQF byte-for-byte). Ship the public site; it replaces the current one.
- **Phase 3 - Identity & member area:** Discord login (Better Auth), profile, TeamSpeak linking (pick-from-list + poke), Steam OpenID linking (roster/vetting), roster view. Import legacy links here.
- **Phase 4 - Discord bot:** interactions endpoint, slash memes, role inspection, role grant/take, the weekly scheduled-event job (creates Operations).
- **Phase 5 - TeamSpeak sync:** ServerQuery worker, Assignable mapping (git-config, seeded from the import), Discord->TS reconcile (CLI dry-run first).
- **Phase 6 - Attendance:** Operations-channel sampling, session reconstruction, read-only attendance/roster views, guest auto-backfill on link (+ a rare admin claim command). Import historical attendance from the legacy DB.
- **Phase 7 - Hardening:** off-box backups + restore drill + second key-holder, log rotation, error-to-Discord alerts, resource limits, ops runbook.

---

## 10. Deferred / revisit triggers

- **Gateway bot** (passive memes, instant auto-role, instant sync): revisit only if genuinely wanted; adds a Node process (ADR 0003).
- **Split hosting** (stack to a separate host): now a cheap change since nothing needs the game box; do it if the game server suffers during ops (ADR 0005).
- **Channel subtree for attendance:** if ops ever split into TeamSpeak sub-channels, widen sampling from the single Operations channel to the parent + descendants (ADR 0007).
- **TeamSpeak 6:** staying on TS3; keep the TS transport behind an interface so raw->SSH->whatever is swappable.
- **Arma engine move (Reforger/Arma 4):** no longer affects attendance (it's TS-based); would at most affect what "Steam/Arma identity" means for the roster.
