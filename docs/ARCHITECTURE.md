# 7R Platform: Architecture & Build Plan

The rebuild of the 7th Ranger Group's software: a public website (info, handbook, briefing generator), a Discord bot, TeamSpeak role sync, and op-attendance tracking, tied together by a verified identity per member.

This document is the plan (the *what* and *why*) and it is the only spec: there is no separate requirements document, and "done" means the phase plan in §9 completes. Architectural decisions are in `docs/adr/`; terminology is in `CONTEXT.md`; every open question from the grilling is resolved in `docs/OPEN-QUESTIONS.md`. For the *how* (config, data-model DDL, sync/link/attendance mechanics) see `docs/IMPLEMENTATION.md`, and for the legacy data import see `docs/MIGRATION.md`.

---

## 1. Decisions at a glance

| Area | Decision | Ref |
|---|---|---|
| Identity | Discord is the hub and the site's only login; TeamSpeak and Steam link onto it | ADR 0001 |
| Roles | Discord roles are the source of truth; TeamSpeak is synced one-way from them | ADR 0002 |
| Role sync | Full reconcile, iterating **our members** (not the guild list), scoped to the mapping; unmapped TS groups (Server Admin, etc.) always persist; dry-run first, then a permanent blast-radius guard | ADR 0002 |
| Admin surface | No admin web UI: git-config mapping, admin slash commands (`/link-force`, `/attendance claim`), CLI sync preview, read-only views only | ADR 0009 |
| Admin permission | A single boolean, derived from a configured set of Discord role ids (`DISCORD_ADMIN_ROLE_IDS`). No permission table, no tiers, no RBAC | this doc |
| Bot | HTTP-only (interactions + REST), no gateway, all-Deno; all commands are slash commands | ADR 0003 |
| **Attendance** | **Sample the single TeamSpeak Operations channel during the op window; no Arma integration.** It is a statistic nobody acts on: it gates nothing | **ADR 0007**, ADR 0010 |
| Legacy data | Import the ~99 identity links and the Assignable definitions. Do **not** import attendance, LOA, per-member assignments, or permissions | ADR 0002, `MIGRATION.md` |
| Deployment | We ship a `compose.yaml`. Where and how it runs is an operational concern for whoever owns the box, not an architectural decision this project makes. CI does own the *act* of deploying (pull, migrate, up), and its script knows the box is Windows | ADR 0005, ADR 0012 |
| Testing | No live test environment (no test guild, no dockerised TeamSpeak). Pure unit tests over the two pure functions; the I/O layer is first exercised in production behind `SYNC_DRY_RUN` and the blast-radius guard | this doc |
| Repo/runtime | One monorepo, Deno 2 + native workspaces, no Nx; every shared package that `apps/web` consumes carries a `package.json` alongside its `deno.json` | ADR 0006 |
| Database | PostgreSQL in Docker; Drizzle ORM (0.45.x, pinned) + drizzle-kit | ADR 0008 |
| Website | Public static content + Discord-authed, **read-only** member area; handbook is Markdown in the repo | this doc |
| Briefing generator | Stateless client-side tool that emits SQF (optionally shareable via URL) | this doc |
| Steam link | A plain profile field. Steam OpenID proves account ownership and yields a SteamID64 members can use to find each other. Optional; gates nothing | this doc |
| TeamSpeak link | One at a time, self-service; proven by picking self from the online-clients list and typing back a code the bot pokes | this doc |
| Ops | Saturday only. The auto-created weekly Discord scheduled event *is* the Operation | this doc |
| Leave of absence | None. Who turns up for an op is the Discord scheduled event's native RSVP ("Interested") list, which the weekly job gives us for free | ADR 0010 |
| Force-link | Admins may manually link via slash command, flagged as unverified | ADR 0009 |

Confirmed unit facts: TeamSpeak is primary voice; the Arma server is self-hosted Windows with full access but **BattlEye off**; ops are **Saturday only**, mission time **20:00-23:00** Europe/Amsterdam (Discord event to 23:30); one Operations channel (ACRE2 handles squad comms); the rank ladder is **Recruit / Member / NCO / Officer / Reserve** (Reserve means "still one of us, not currently active" and sorts last); the legacy dump is in the repo at `data/Dump20260711.sql`; staying on TS3 and Arma 3. The legacy also ran Wednesday ops (119 of them). That is history: the unit does not any more.

---

## 2. System architecture

Three containers plus the unchanged external TeamSpeak and Discord. We ship the Compose file; the reverse proxy and TLS in front of it belong to whoever runs the box (ADR 0005).

```
                    ┌──────────────── compose.yaml (what we ship) ────────────────────────────────────┐
                    │                                                                                 │
 Internet ─443─▶ ┌───────────────┐        ┌───────────────┐          ┌───────────────┐                │
                 │ reverse proxy │──────▶ │  web (Astro   │─────────▶│   postgres    │◀──────┐        │
                 │ + TLS (host)  │        │  SSR, Deno)   │          │  (Docker vol) │       │        │
                 └───────────────┘        └──────┬────────┘          └───────┬───────┘       │        │
                        ▲                        │ shares DB                 │ shares DB     │        │
 Discord interactions ──┘                        │                           │               │        │
 (Ed25519 webhook) ─────────────▶ /api/discord/interactions                  │               │        │
                                                 │ internal HTTP             │               │        │
                                                 │ (compose network only)    │               │        │
                                                 ▼                           │               │        │
                                        ┌───────────────┐  ServerQuery       │               │        │
                                        │    worker     │──(ssh:10022)──▶ TeamSpeak (extern) │        │
                                        │    (Deno)     │──Discord REST──▶ Discord API       │        │
                                        └───────────────┘                                    │        │
                    │                    (samples Operations channel; reconciles TS groups;  │        │
                    │                     creates the weekly event; verifies links)          │        │
                    └─────────────────────────────────────────────────────────────────────────────────┘
```

- **reverse proxy + TLS**: already exists on the intended host. The `web` service is added as an upstream. Not our deliverable (ADR 0005).
- **web**: Astro 7 SSR on Deno. Public site (static/prerendered), Discord-authed member area (read-only views plus self-service linking, ADR 0009), Discord OAuth login (Better Auth), Steam OpenID linking, and the Discord **interactions endpoint** (`/api/discord/interactions`, Ed25519-verified) handling all slash commands. There is no admin panel.
- **worker**: one long-running Deno process holding the TeamSpeak ServerQuery connection (link verification + group reconcile + attendance sampling) and the scheduled Discord REST jobs (create the weekly event, poll roles, reconcile).
- **postgres**: the durable state web and worker share (identity links, role mapping, operations, attendance, link codes, auth/session tables).
- **web -> worker, internal HTTP**: the worker exposes a small API on the Compose network only (never through the proxy, never public), because the TeamSpeak link flow needs live access to the ServerQuery connection the worker holds: `GET /internal/ts/clients` (online, unlinked clients for the pick-list) and `POST /internal/ts/poke` (send the link code). Authenticated with a shared secret (`WORKER_INTERNAL_TOKEN`). This is the only coupling between the two services beyond the database. It is deliberately synchronous: if the worker is down, linking fails loudly rather than silently hanging.

The worker and web are separate processes (worker runs continuously on timers and a persistent TS connection; web is request/response) but one repo sharing the domain and DB packages, which is the coupling that justifies the monorepo (ADR 0006).

---

## 3. Data model

PostgreSQL. Sketch (columns illustrative):

**member**: the person / hub.
- `id`, `discord_id` (unique, **required**), `display_name`, `disabled_at`, timestamps
- TeamSpeak (one current, replaceable): `ts_uid` (unique, nullable), `ts_nickname`, `ts_verified_at`, `ts_link_method` (`poke` | `manual` | `legacy_import`)
- Steam (optional, a plain profile field): `steam_id` (unique, nullable), `steam_verified_at`, `steam_link_method` (`openid` | `manual`)
- `manual` link method is the admin force-link flag (marks a link as not self-verified); `legacy_import` marks a link carried over from the old DB and flagged for re-verification.
- `disabled_at` is stamped by the role sync the first time a member is seen missing from the Discord guild (§4.4). In the legacy this column existed but was never used.

**assignable**: a rank / role / badge and its mapping.
- `id`, `kind` (`rank` | `role` | `badge`), `name`, `discord_role_id` (unique), `ts_sgid` (nullable), `sort_order`
- **Rank** is a member's standing and is **exclusive** (exactly one): Recruit, Member, NCO, Officer, Reserve.
- **Role** is a staff function a member is appointed to (Recruiter, Instructor, Mission maker). Additive.
- **Badge** is a training qualification a member earned (Medic, Marksman, Engineer, Armoured, Heavy Weapons, Leadership, Rotary Aviation, Fixed-Wing Aviation). Additive. A Role is not a qualification: Medic and Pilot are badges.
- No `category` column: `kind` + `sort_order` already cover grouping and display.
- The set of non-null `ts_sgid` is the "owned set" the sync reconciles; everything else on TS is left alone.
- The 8 legacy badges have **no Discord role** (they were TeamSpeak groups only). Since ADR 0002 makes Discord authoritative for every Assignable, Phase 0 creates the 8 badge roles in Discord and backfills the 83 legacy grants.

**operation**: one op.
- `id`, `date`, `attendance_start` (20:00), `attendance_end` (23:00), `event_end` (23:30), `discord_event_id`, `name`, `source` (`auto_weekly` | `manual`)
- The weekly job creates the Discord scheduled event and this row together, one per Saturday.

**attendance_session**: one continuous presence span in the Operations channel.
- `id`, `operation_id`, `member_id` (**nullable** = guest), `ts_uid` (raw sampled), `ts_nickname`, `joined_at`, `left_at`
- Reconstructed from periodic samples of the Operations channel. Credit is derived: a member is credited if the sum of in-window session minutes >= 60. Guest sessions (unlinked `ts_uid`) auto-backfill to a member the moment that person links their TeamSpeak identity.

**link_code**: one-time TeamSpeak possession challenge.
- `id`, `code`, `member_id`, `target_ts_uid` (the client the member picked, that the bot pokes), `expires_at`, `consumed_at`
- Steam uses OpenID and needs no code.

**Auth/session tables**: owned by Better Auth, which has its own session table and signed cookie. **No Astro session driver is configured.** A full Discord login was verified working on Deno + Postgres with no session store configured at all; the earlier claim that "logins break without unstorage in Postgres" is false. (Astro still hard-depends on the `unstorage` package; what we drop is the config, not the dependency.)

There is **no `loa` table**: leave of absence is not a concept in this system (see §1).

Fixes vs the legacy: operations are real rows with real windows (the legacy `operation` table had no date column at all); attendance still keys on the TeamSpeak identity (as before) but now resolves through the `member` hub; demotions propagate; Steam is actually wired up, as an optional profile field.

---

## 4. Subsystems

### 4.1 Website (`apps/web`, Astro 7 on Deno)

- **Public, static/prerendered:** landing/recruitment, about, handbook, briefing generator.
- **Handbook:** **Starlight**, Markdown in `content/handbook/` (migrate the current 21 files, ~31k words, 96 images, **and restore the older dropped sections** FAQ / Loadouts / Formations / Extended handbook, after a content sanity-check). Edited via GitHub/PR. The loadout Google Sheet stays external (linked from the handbook).
  - Astro renders Markdown natively; Starlight is not needed for that. It is here for the **sidebar nav and the built-in Pagefind search**, which is the whole value for a 31k-word document people look things up in. Today's table of contents is hand-maintained in `index.md`.
  - **No `starlight-versions`.** Nobody asked to browse historical handbook versions, and git history already answers "what did it say before". Dropped rather than carried.
  - **The files must stay `.md`, never `.mdx`.** The content embeds **92 raw HTML `<img>` tags** with inline styles (`style="float:right;width:500px;"`) plus 15 unclosed `<br>`. Astro Markdown passes raw HTML through untouched. MDX would parse them as JSX, where a string `style` attribute is invalid and an unclosed `<br>` is a parse error: converting to MDX breaks all 92 images at once.
  - **Migration cost is the images, not Starlight.** 103 files under `public/wiki/images/`, referenced by absolute `/wiki/images/...` paths, so either keep that path or rewrite all 96 references. The inline `float:right;width:500px` styles were authored against a wider column than Starlight's and should be stripped in favour of a content-width-aware image style.
- **Briefing generator:** a hydrated island (Preact/Svelte, decide in the web spike) reproducing the current tool's SQF output **byte-for-byte** (`createDiaryRecord` blocks in reverse insertion order). Stateless: fill in, copy the SQF, optionally share via a URL that encodes the inputs. No backend.
- **Member area (SSR, Discord-authed):** **read-only, plus self-service linking.** Your profile (Discord + linked TeamSpeak + linked Steam), link/unlink TeamSpeak and Steam, view your own attendance, and a plain read-only roster. There is **no admin web panel** (ADR 0009): the Assignable mapping is git-config applied by a seed task, force-link (`/link-force`) and guest-claim (`/attendance claim`) are admin-gated slash commands, and the sync dry-run is `deno task sync:preview`. No operations admin, no vetting view, no permissions screen.
- **Auth:** Better Auth with the Discord social provider (Lucia is deprecated). OAuth scopes stay at `identify` (+ `email`). Guild membership and roles do **not** come from OAuth: they come from the bot token (§4.4).
- **Discord interactions endpoint:** `/api/discord/interactions`, Ed25519 verified with native WebCrypto (no polyfill, no flags). It **fails closed**: any exception is a 401, never a 200. Discord deliberately sends invalid signatures to probe the endpoint and will remove the interactions URL if one is ever accepted. Verify over the raw request body bytes, never `JSON.parse` then re-stringify. Reply within 3 seconds or ack deferred (type 5), which matters on a cold container start.

### 4.2 Discord bot (HTTP-only)

Commands handled by the web interactions endpoint; scheduled writes run in the worker. All Discord calls use plain `fetch` (a ~20-line helper); `@discordjs/rest` costs 9 transitive dependencies including a second HTTP stack to buy rate-limit bucketing we do not need at roughly one request every three minutes.

- **Memes:** ported from `fun.py` (the image+caption pairs, the "slav" set, `!ff`/`!monkey`/`!medic`/`!8ball`/`!rps`, the `!slotting` squad-dealer), now slash commands with ephemeral replies and per-role gating. **The images are not hosted by the old bot.** They are Discord CDN attachment links hardcoded in `fun.py`, and they now return **404 to any anonymous client**: since 2023-24 Discord CDN links require signed `ex`/`is`/`hm` params, and they still render in Discord only because the client re-signs its own URLs. Procedure, in this order: **rotate the leaked bot token first**, then call `POST /api/v9/attachments/refresh-urls` with the new token to get freshly-signed URLs, download all 25 images, commit them to the repo, and serve them from our own domain.
- **Role inspection:** "who has role X", "what roles does @user have", "who is missing role Y", roster export. Reads members via REST (GUILD_MEMBERS privileged intent, which the REST member list needs, not just the gateway).
- **Role and rank commands:** admin-gated `/role` and `/rank set`, honoring the role-hierarchy rule and writing audit-log reasons. Setting a rank removes the member's other rank roles: rank is exclusive.
- **Force-link:** `/link-force`, admin-gated, marks the link `manual` (ADR 0009).
- **Weekly event (worker job):** idempotently create the Saturday event (`POST /guilds/{id}/scheduled-events`, EXTERNAL, location = TeamSpeak/server). This needs **`CREATE_EVENTS` (1<<44)**, not `MANAGE_EVENTS` (1<<33), which only edits and deletes events that already exist and will 403 on create. Event window 20:00-23:30 Europe/Amsterdam, DST-correct (compute real local time). Creating the event creates the Operation row (attendance window 20:00-23:00). The event's native RSVP list is the unit's op planning: there is no LOA feature.

### 4.3 Identity linking

One Member, verified across three namespaces:
- **Discord**: proven by the OAuth login itself (the hub).
- **TeamSpeak**: possession challenge, bot-initiated (members cannot see the query bot to message it): the member, connected to TeamSpeak, opens "link TeamSpeak"; the site shows the currently-online, unlinked TS clients (usually just them); the member picks themselves; the worker pokes that client a one-time code; the member types the code back on the site to confirm. One current link, self-service replaceable. Linking also auto-backfills any guest attendance sessions with that `ts_uid`.
- **Steam**: Steam OpenID ("Sign in through Steam", live in 2026, ~60 lines direct). It proves account ownership and yields the SteamID64, which members can use to find each other in game. It is a **plain profile field**: optional, applies no vetting rule, and gates nothing. A member without one is not "incomplete".

### 4.4 Role sync (Discord -> TeamSpeak, worker)

- **The reconcile iterates our members, not the Discord guild member list.** This is a bug fix against the earlier design. Looping over guild members means anyone who *leaves* the unit simply vanishes from the poll, is never reconciled, and keeps their TeamSpeak groups forever. Inverted: iterate the members in our database that have a linked `ts_uid`, and look up each one's Discord roles from the polled guild data. A leaver has no roles, so their desired set is empty, so every owned group is removed on the next pass. No special case needed. The same pass stamps `disabled_at` the first time a member is seen missing from the guild.
- **Poll:** guild members via REST every few minutes with the bot token. **Always pass `?limit=1000` and paginate with `after`**: `GET /guilds/{id}/members` defaults to `limit=1`, and missing this presents as "sync mostly doesn't work" rather than as an error. For a single member, `GET /guilds/{guild_id}/members/{user_id}` returns `roles[]`, needs no OAuth scope, 404s cleanly for non-members, and works with the user absent.
- **Reconcile:** the legacy `rangers-site` three-way algorithm: assign missing owned groups, remove owned groups they no longer qualify for, **never touch groups outside the owned set**. Operate on `cldbid` (resolved via `clientgetdbidfromuid`). This is one of the two pure functions the test suite covers.
- **Blast-radius guard (permanent):** if a single pass would REMOVE owned groups from more than `SYNC_MAX_REMOVALS` members (default 5), it halts, applies nothing, and posts to the error Discord webhook. Normal operation touches 0-2 people, so a mass removal is definitionally a bug: a bad mapping, an empty Discord poll, TeamSpeak returning garbage. Additions stay automatic. This is a standing guard, not a first-run check: the dry-run protects run #1, this protects run #200.
- **Dry-run:** `deno task sync:preview` prints the plan and writes nothing. Run it before the first real sync (ADR 0009).
- **Transport:** ServerQuery via `ts3-nodejs-library` (npm:), **SSH on port 10022**, which is mandatory: TeamSpeak is reached over the public internet (`ts.7th-ranger.com`), so raw ServerQuery on 10011 would put the query password in cleartext on the wire on every reconnect. The library is verified working under Deno end to end (pure JS crypto, zero native addons, only `--allow-net`), but pin the Deno version exactly and commit `deno.lock`: `ssh2` leans on `node:crypto` for `aes128-gcm@openssh.com`, the code path Deno broke three times and repaired in February 2026. Never run `deno approve-scripts` / `--allow-scripts`.
- Create a dedicated query login and IP-allowlist the bot (lifts the 10-cmd/3s throttle).

### 4.5 Operations & attendance (worker)

**Attendance is a statistic and nothing else.** Nobody acts on it: it gates no promotion, triggers no removal, and feeds no report anyone reads. It appears on a member's own profile and in a read-only site view. That is the whole feature, and it is the reason it sits late in the phase plan and is a candidate to cut (§10).

- **The weekly job** creates the Discord event + Operation (§4.2), one per Saturday.
- **Sampling:** during the attendance window (20:00-23:00 Europe/Amsterdam), the worker polls the single **Operations channel** membership via ServerQuery (`clientList({ cid })`) every ~90 seconds, recording which TS UIDs are present.
- **Reconstruction:** diff consecutive samples into `attendance_session` join/leave spans per TS identity (the legacy diffing approach). Resolve `ts_uid` -> member; unmatched = guest. This is the second of the two pure functions the test suite covers.
- **Credit:** sum in-window minutes per member; credited if >= 60. Close any dangling session at the window's end.
- **Guests:** a guest session backfills to a member automatically when that person links their TeamSpeak identity (ADR 0009). The `/attendance claim` admin command exists as a fallback for leftovers.
- **No historical import.** Attendance starts from zero (§8).
- No Arma server connection, no framework changes, no log parsing, no A2S.

---

## 5. Repo layout

```
rangers-platform/
  deno.json                 # workspace members, tasks, single lockfile
  deno.lock                 # committed; Deno version is pinned exactly (§4.4)
  compose.yaml              # web + worker + postgres (this is the deployment deliverable)
  CONTEXT.md                # glossary
  data/
    Dump20260711.sql        # the legacy MySQL dump
  docs/
    ARCHITECTURE.md         # this file (the spec)
    OPEN-QUESTIONS.md       # resolved-question log
    IMPLEMENTATION.md       # the how
    MIGRATION.md            # legacy import
    adr/                    # 0001..0011
  packages/
    config/                 # env parsing, fails loud at boot
    domain/                 # Member, Operation, Assignable, attendance rules; zero I/O
    db/                     # Drizzle schema + drizzle-kit migrations + queries (ADR 0008)
    discord/                # fetch-based REST helpers, Ed25519 verify, command definitions
    teamspeak/              # ServerQuery client, group reconcile (ported), channel sampling, poke-link
    identity/               # linking logic, link codes
  apps/
    web/                    # Astro 7 (package.json member)
    worker/                 # Deno long-running process
  content/
    handbook/               # Markdown + images (migrated + restored sections)
```

**Every shared package that `apps/web` consumes needs a `package.json` alongside its `deno.json`.** Astro's bundler cannot resolve a deno.json-only workspace member (`Rolldown failed to resolve import "@7r/db"`). Verified working with both files present. Without this, the monorepo's one stated benefit (a shared domain/db layer consumed by web *and* worker) does not materialise for the website, so this is not optional bookkeeping (ADR 0006).

Two survival rules in the worker: an `unhandledrejection` handler that logs and continues (Deno kills the process by default; a stray error must not drop the TS connection), and a clean ServerQuery reconnect (reuse the legacy's `removeAllListeners` reconnect guard).

Build notes: build Astro **with Deno** (`deno run -A npm:astro build`), and add `RUN deno cache dist/server/entry.mjs` at image-build time so a cold boot does not pull ~119 files from jsr.io (an outage would then kill the container). Apply DB migrations with the runtime migrator (`drizzle-orm/postgres-js/migrator`), never `drizzle-kit migrate`, which drags tsx and three copies of esbuild into the image.

---

## 6. Deployment & operations

**Infrastructure is out of scope (ADR 0005).** The deliverable is a `compose.yaml`. Where and how it runs is an operational concern for whoever owns the box, not an architectural decision this project makes.

- **What we ship:** `web` + `worker` + `postgres`, with Postgres on a Docker-managed volume, and the `web` service exposed for the host's existing reverse proxy to front.
- **Secrets:** Compose file-based `secrets:` for the DB password, Discord bot token, TeamSpeak query password, session key. Not committed, not in images.
- **CI/CD:** GitHub Actions builds images to GHCR (reuse the existing namespace); deploy by `docker compose pull && up -d`, pinned to a commit SHA. No Watchtower on our own images.
- **Logging:** turn on `json-file` log rotation. Docker does none by default and a chatty container can fill the disk.
- **Observability:** the worker posts its own errors to a private Discord webhook. The blast-radius guard (§4.4) posts there too.
- **No backups (ADR 0011).** No restic, no off-box storage, no restore drill, no second key-holder. The only irreplaceable data is roughly 100 TeamSpeak links, a few kilobytes. Everything else rebuilds itself: Discord roles live in Discord (ADR 0002), the Assignable mapping is git-tracked config (ADR 0009), Steam is a re-linkable profile field, the handbook is in git, and no attendance history is imported. Worst case, the unit re-links over a week. (Non-binding suggestion, not a requirement: a `pg_dump` to another folder on the same box costs nothing and guards against a bad migration, which is a likelier failure than losing the disk.)

**Known hazard, owned by the operator, not solved here:** on Windows, Docker Desktop's engine only starts inside an interactive Windows login session (docker/roadmap#515, open since 2023). After an unattended reboot there is no daemon, `restart: unless-stopped` never fires, and the stack stays down silently. Recorded, not fixed.

---

## 7. Security

- **Rotate the leaked 2019 bot token, first, before anything else.** The repo is now private, but the token was public for ~7 years, so making the repo private does **not** un-leak it. Rotation must happen *before* the meme harvest (§4.2), which needs a valid bot token to call `/attachments/refresh-urls`. The Arma server password (`orbs`) must also no longer be printed by any command (the old `!server` leaked it).
- **Least privilege** for the bot: **`CREATE_EVENTS` + `MANAGE_ROLES`**, plus the **GUILD_MEMBERS** privileged intent enabled in the developer portal (required for the REST member list, not only for the gateway). Nothing more. Not `MANAGE_EVENTS`: it cannot create.
- **Interactions endpoint fails closed** (§4.1). A single accepted invalid signature gets the endpoint removed by Discord, which is a silent, delayed bot death.
- **Admin** is a single boolean derived from `DISCORD_ADMIN_ROLE_IDS`. No permission table, no tiers. The legacy 7-permission model is deliberately not ported.
- **Privacy (EU unit, GDPR-lite):** store only `discord_id`, `ts_uid`, `steam_id`, display names, attendance timestamps. No LOA data exists in this system at all. Members can self-unlink and request deletion. Document retention.

---

## 8. What we carry over from the old code

- **Steal:** the `rangers-site` TeamSpeak three-way reconcile (`teamspeak.service.ts`), its reconnect guard, and its `record-operation-attendees` channel-sampling + diffing (now the core of attendance); the identity-hub shape; the Assignable idea (rank/role/badge). The `rangers-mono` handbook content + the briefing generator's exact SQF template. The `fun.py` meme content and `!slotting` algorithm.
- **Bin:** EOL toolchains, the Nx build, discord.py 1.3.4, leaked-secret plumbing, the add-only Discord sync, the empty legacy OperationModel, the 7-permission model.
- **Memes:** the 25 images are *not* hosted by the old bot and are *not* still fetchable. They are Discord CDN attachment URLs that 404 anonymously. Rotate the token, refresh the URLs via `/attachments/refresh-urls`, download, commit to the repo, self-host (§4.2).
- **Migrate from the legacy dump (`data/Dump20260711.sql`):** the ~99 Discord-to-TeamSpeak identity links (`member.discord_id` + `ts_uid`, marked `legacy_import` and flagged for re-verification), and the Assignable **definitions** (names + Discord role ids). TeamSpeak sgids are re-derived by name against the **live** server, never taken from the dump: the dump holds two families of ids for the same group names because the TS server was rebuilt at some point, and the stored numbers may be dead. Steam **was** populated (23 users have a SteamID64), contrary to the earlier claim.
- **Do not migrate:** per-member rank/role/badge assignments (Discord is the truth), sessions, applications, incidents, enjinTags, migrations, permissions, LOA, and **historical attendance**.
- **Why no historical attendance** (75,241 samples, 401 operations): it is a stat nobody acts on; the last write was 2024-07-27, two years dead, and the unit did not notice; 113 of the 401 ops have zero samples; the legacy `operation` table has no date column at all; 90 of the 188 TeamSpeak attendees link to no member; and its 15-minute sample resolution does not match our 90-second sampling, so importing it would quietly mix two precisions in one column. Attendance starts from zero.

Real legacy row counts (parsed from the dump; the AUTO_INCREMENT values quoted previously were wrong): `user` **150** (all 150 have a Discord id, 99 have a TeamSpeak id, 23 have Steam, 76 have a rank, `disabled` is 0 for every row), `teamspeakUser` 228, `operation` 401, `attendance` 75,241, `loa` 2,667, `badge` 8, `role` 3, `rank` 5, `permission` 7, `user_badges_badge` 83 grants across 32 members, `user_roles_role` 21. `application`, `incident` and `incident_users_user` are empty stubs.

---

## 9. Phased build plan

The old plan put TeamSpeak sync at Phase 5 of 7, behind a full rebuild of a website that already works. That was backwards. The unit's real, felt, recurring pain is hand-managing TeamSpeak groups; the site and bot already serve, so the content port blocks nobody and must not be allowed to stall the useful part.

- **Phase 0 - Prep (no code):** rotate the leaked bot token; harvest and commit the 25 meme images via `/attachments/refresh-urls` (in that order); **create the 8 badge roles in Discord and backfill the 83 legacy grants** (scriptable: every legacy user has a Discord id); confirm the reused Discord app / guild / GHCR namespace. The legacy dump is already at `data/Dump20260711.sql`.
- **Phase 1 - Foundation:** monorepo skeleton (Deno workspaces), `config`, `domain`, `db` (Drizzle schema + first migration), Compose with Postgres, CI to GHCR.
- **Phase 2 - Identity (minimal web app):** Discord login (Better Auth), member profile, TeamSpeak linking (pick-from-list + poked code), Steam OpenID linking. No public content yet. Import the legacy identity links here.
- **Phase 3 - TeamSpeak sync:** ServerQuery worker, seed the Assignable mapping from git config (sgids resolved live by name, with the proposed mapping printed to the terminal for confirmation before any write), Discord-to-TeamSpeak reconcile with `deno task sync:preview` first, then the blast-radius guard. **This is the phase that pays for the project.**
- **Phase 4 - Discord bot:** interactions endpoint, slash memes, role inspection, `/role` and `/rank set`, `/link-force`, and the weekly scheduled-event job (which creates Operations).
- **Phase 5 - Attendance:** Operations-channel sampling, session reconstruction, read-only member and site views, guest auto-backfill on link. No historical import.
- **Phase 6 - Public content:** the public site, branding, handbook (Starlight, no versioning; migrate the 21 `.md` files, move the 103 images, strip the inline `<img>` styles, restore the dropped sections), the stateless briefing generator (SQF byte-for-byte). This replaces the current public site, which serves fine until then.

There is no Phase 7. Backups are cut (§6) and infrastructure is out of scope (ADR 0005). What remained of "hardening" (log rotation, error-to-Discord alerts, resource limits) folds into the phases that need it.

**Cutover is incremental, not big-bang.** The old Discord bot and the old website are both still running, and both keep running. Nothing currently writes TeamSpeak server-groups: the legacy sync was never finished, and the attendance recorder's last write was 2024-07-27. So the new reconcile is the only writer, there is no old sync to fight, and no "kill the old sync" step is needed. Slash commands cannot collide with the old bot's `!` prefix commands, so the two bots coexist safely until the old one is retired. TeamSpeak groups are maintained **by hand** today, and that hand-work is the toil this project actually removes.

**Testing**: there is no live test environment, no test Discord guild and no dockerised TeamSpeak server. Testing is pure unit tests over the two pure functions: the three-way group reconcile, and the sample-to-session reconstruction. The I/O layer is exercised for the first time in production, behind `SYNC_DRY_RUN` and the blast-radius guard. The cost of that trade-off is real and is accepted: transport, auth, escaping and pagination bugs surface against the live server, on the live guild, in front of the unit. The guard exists precisely because that is where they will surface.

---

## 10. Deferred / revisit triggers

- **Attendance itself:** it is a statistic nobody acts on. If that is still true once it ships, cutting the feature is on the table: it is the largest chunk of running machinery in the system that serves no decision. Revisit if anyone ever asks to *act* on the number (promotion gates, activity checks); until then it stays optional and last.
- **Gateway bot** (passive memes, instant auto-role, instant sync): revisit only if genuinely wanted. It is technically viable on Deno now (a live gateway connection from Deno 2.9.2 returned `op = 10 HELLO` with zero npm packages), so the reason we do not have one is not "it breaks": it is that no always-on stateful process is needed, and the interactions endpoint is just a route the web app already serves (ADR 0003).
- **Hosting:** out of scope (ADR 0005). If the game server suffers during ops, moving the stack to another host is the operator's call and costs nothing architecturally, since nothing in it needs the game box.
- **Channel subtree for attendance:** if ops ever split into TeamSpeak sub-channels, widen sampling from the single Operations channel to the parent + descendants (ADR 0007).
- **TeamSpeak 6:** staying on TS3. Keep the TS transport behind an interface so it stays swappable, but the SSH transport is not optional and the interface must never permit a fallback to raw ServerQuery on 10011 (§4.4).
- **Drizzle 1.0:** stay on 0.45.x, pinned; 1.0 is still in RC and will land mid-project. Do not adopt the relational query builder (`.query` / `relations()`) and do not use the global `casing` option, so two of the three v1 breaking changes will simply not apply and the eventual upgrade shrinks to the migrations-folder restructure.
- **Arma engine move (Reforger/Arma 4):** does not affect attendance (it is TeamSpeak-based); would at most affect what a Steam id means on a profile.
