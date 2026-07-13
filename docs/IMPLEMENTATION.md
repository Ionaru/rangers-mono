# 7R Platform: Implementation Guide

The concrete mechanics an implementer needs, beyond the decisions in `docs/adr/` and the shape in `docs/ARCHITECTURE.md`. If something here contradicts an ADR, the ADR wins and this doc is stale. Legacy import specifics are in `docs/MIGRATION.md`.

---

## 1. Stack & pinned choices

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Deno 2, **exact version pinned**, `deno.lock` committed | non-negotiable: `ssh2` (TeamSpeak) leans on `node:crypto` for `aes128-gcm@openssh.com`, the exact path Deno broke three times and only repaired in Feb 2026 (denoland/deno#32290) |
| Repo | Deno workspaces (`deno.json` `workspace`) | every shared package that `apps/web` consumes also needs a `package.json` (ADR 0006, see §12) |
| Web | Astro 7 SSR, `@deno/astro-adapter` (pin, fast-moving 0.x) | **build with Deno**: `deno run -A npm:astro build`, run `deno run -A dist/server/entry.mjs`. Add `RUN deno cache dist/server/entry.mjs` at image-build time |
| Handbook | Starlight (no `starlight-versions`) | Markdown in `content/handbook/`. Astro renders Markdown natively; Starlight buys the sidebar + Pagefind search. Files stay **`.md`, never `.mdx`**: the content has 92 raw `<img>` tags with string `style` attributes and unclosed `<br>`, which MDX rejects |
| Auth | Better Auth, Discord social provider | Better Auth owns its own session table and signed cookie. No Astro session driver is configured; none is needed |
| DB | PostgreSQL, Drizzle ORM **0.45.x pinned** + drizzle-kit, `postgres.js` driver | ADR 0008, and the v1 guardrails in §12 |
| Discord REST | plain `fetch` (~20-line helper) | **not** `@discordjs/rest`: 9 transitive deps incl. a second HTTP stack, to buy rate-limit bucketing worth nothing at ~1 request / 3 min. `discord-api-types` as a types-only dev dep if the enums are wanted. No gateway (ADR 0003) |
| Discord interactions | native WebCrypto Ed25519 verify | zero flags, no polyfill. Endpoint in `apps/web` |
| TeamSpeak | `ts3-nodejs-library` (`npm:`), SSH transport (port 10022) | verified working under Deno end to end: pure-JS crypto, zero native addons, only `--allow-net`. Flood 10 cmds / 3s; lib backs off on 524 |
| Reverse proxy | existing nginx + Let's Encrypt on the box | add `web` upstream (ADR 0005) |

The Astro runtime image ships **no `node_modules`**. Building with `npx astro build` instead produces an artifact that dies at boot (`error: Import "unstorage" not a dependency`) unless ~276 MB of `node_modules` is copied into the runtime image. There is no Node builder stage.

---

## 2. Configuration (env / secrets)

All config is parsed in `packages/config` and **fails loud at boot** if a required value is missing.

The database password and URL are file-based Docker Compose `secrets:`, mounted at `/run/secrets/*`. Every other value, secret or not, reaches `web` and `worker` as plain environment from a git-ignored `.env` on the box, which Compose loads with `env_file:` (ADR 0014). Nothing is ever baked into an image. For any key `X`, a mounted `X_FILE` **beats** a directly-set `X`.

```
# Core
DATABASE_URL=postgres://…                     # secret
SESSION_SECRET=…                              # secret (Better Auth / cookie signing)
PUBLIC_BASE_URL=https://7th-ranger.com

# Discord
DISCORD_GUILD_ID=305471712546390017
DISCORD_CLIENT_ID=…                            # 7R_Bot's application id: OAuth login and command registration
DISCORD_CLIENT_SECRET=…                        # secret; same application
DISCORD_BOT_TOKEN=…                            # secret; 7R_Bot's, not the 2019 bot's (ARCHITECTURE §7, ADR 0015)
DISCORD_PUBLIC_KEY=…                           # interactions Ed25519 verify; same application as the token
DISCORD_ADMIN_ROLE_IDS=…,…                     # admin is a single boolean derived from these

# Steam (optional profile field)
STEAM_REALM=https://7th-ranger.com
# (Steam OpenID is stateless; no API key required for login. Optional STEAM_WEB_API_KEY for profile display.)

# TeamSpeak ServerQuery
TS_QUERY_HOST=ts.7th-ranger.com
TS_QUERY_PORT=10022                            # SSH query; mandatory, the host is on the public internet
TS_QUERY_USER=…                                # secret
TS_QUERY_PASS=…                                # secret
TS_VIRTUALSERVER_ID=1
TS_OPERATIONS_CHANNEL_CID=…                    # the single Operations channel
TS_BOT_NICKNAME=7R Bot                         # the ServerQuery client's nickname, set on connect

# Internal web -> worker API (Compose network only; never proxied, never public)
WORKER_INTERNAL_URL=http://worker:8080
WORKER_INTERNAL_TOKEN=…                          # secret; shared between web and worker

# Ops schedule / attendance
OP_TIMEZONE=Europe/Amsterdam
OP_WEEKLY_CRON=0 20 * * 6                       # Sat 20:00 local (compute DST-correct). Saturday only.
OP_ATTENDANCE_START=20:00
OP_ATTENDANCE_END=23:00
OP_EVENT_END=23:30
ATTENDANCE_MIN_MINUTES=60
ATTENDANCE_SAMPLE_SECONDS=90

# Sync
ROLE_SYNC_INTERVAL_SECONDS=300
SYNC_DRY_RUN=true                              # start true; flip after the first preview looks right
SYNC_MAX_REMOVALS=5                            # blast-radius guard; a pass touching more members than this HALTS

# Ops
ERROR_ALERT_DISCORD_WEBHOOK=…                  # secret; worker posts its own errors here
```

`TS_QUERY_PORT` is never 10011. Raw ServerQuery is cleartext, and this connection crosses the public internet on every reconnect.

---

## 3. Data model (Drizzle sketch)

Defined in `packages/db/schema.ts`. Illustrative, not final. IDs are app-generated (uuid or bigint identity); external IDs are stored as `text` (Discord/TS/Steam snowflakes exceed JS number range).

```ts
// member: the person / hub
member = pgTable('member', {
  id: uuid().primaryKey().defaultRandom(),
  discordId: text('discord_id').notNull().unique(),         // required: the login + role source
  displayName: text('display_name').notNull(),
  disabledAt: timestamp('disabled_at'),                     // stamped when first seen missing from the guild (§6)
  // TeamSpeak: one current, replaceable
  tsUid: text('ts_uid').unique(),
  tsNickname: text('ts_nickname'),
  tsVerifiedAt: timestamp('ts_verified_at'),
  tsLinkMethod: text('ts_link_method'),                     // 'poke' | 'manual' | 'legacy_import'
  // Steam: optional profile field. Proves account ownership, gates nothing.
  steamId: text('steam_id').unique(),
  steamVerifiedAt: timestamp('steam_verified_at'),
  steamLinkMethod: text('steam_link_method'),               // 'openid' | 'manual'
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// assignable: rank | role | badge, and its mapping. Discord is authoritative (ADR 0002).
//   rank  = standing, EXCLUSIVE (Recruit, Member, NCO, Officer, Reserve)
//   role  = staff function, additive (Recruiter, Instructor, Mission maker)
//   badge = training qualification, additive (Medic, Marksman, Engineer, Armoured,
//           Heavy Weapons, Leadership, Rotary Aviation, Fixed-Wing Aviation)
assignable = pgTable('assignable', {
  id: uuid().primaryKey().defaultRandom(),
  kind: text().notNull(),                                    // 'rank' | 'role' | 'badge'
  name: text().notNull(),
  discordRoleId: text('discord_role_id').notNull().unique(),
  tsSgid: integer('ts_sgid'),                                // nullable; null = not mirrored to TS
  sortOrder: integer('sort_order').default(0),               // Reserve sorts last among ranks
})

// operation: one op, Saturdays only. The weekly job creates the row + the Discord event together.
operation = pgTable('operation', {
  id: uuid().primaryKey().defaultRandom(),
  date: date().notNull(),
  attendanceStart: timestamp('attendance_start').notNull(), // 20:00 local
  attendanceEnd: timestamp('attendance_end').notNull(),     // 23:00 local
  eventEnd: timestamp('event_end').notNull(),               // 23:30 local
  discordEventId: text('discord_event_id'),
  name: text(),
  source: text().notNull().default('auto_weekly'),          // 'auto_weekly' | 'manual'
})

// attendance_session: one presence span in the Operations channel, reconstructed from samples.
attendanceSession = pgTable('attendance_session', {
  id: uuid().primaryKey().defaultRandom(),
  operationId: uuid('operation_id').notNull().references(() => operation.id),
  memberId: uuid('member_id').references(() => member.id),   // null = guest (unlinked ts_uid)
  tsUid: text('ts_uid').notNull(),
  tsNickname: text('ts_nickname'),
  joinedAt: timestamp('joined_at').notNull(),
  leftAt: timestamp('left_at'),
})

// link_code: one-time TeamSpeak possession challenge (Steam uses OpenID, no code)
linkCode = pgTable('link_code', {
  id: uuid().primaryKey().defaultRandom(),
  code: text().notNull(),
  memberId: uuid('member_id').notNull().references(() => member.id),
  targetTsUid: text('target_ts_uid').notNull(),             // the client the member picked; the bot pokes it
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
})
```

There is **no `loa` table**. Leave of absence is not a concept in this system: who turns up for an op is answered by the Discord scheduled event's native RSVP ("Interested") list, which the weekly job gives us for free.

There is **no permission table**. Admin is a single boolean derived from `DISCORD_ADMIN_ROLE_IDS`.

Better Auth manages its own auth/session tables. Do not model users there; `member` is the domain record, keyed by `discordId`, and links to the auth identity by Discord id.

Ranks are **mutually exclusive** (a member holds exactly one rank); roles and badges are additive. This is enforced on the Discord side (see §5), not by a DB constraint.

---

## 4. Identity linking flows

### Discord (login, the hub)
Better Auth Discord provider, OAuth2 authorization-code. Scopes: `identify` (+ `email`). **Do not request `guilds` or `guilds.members.read`**: Better Auth only ever calls `POST /oauth2/token` and `GET /users/@me`, and surfaces zero guild data no matter what scopes are granted.

Guild membership and roles come from the **bot token**, not from OAuth: `GET /guilds/{guild_id}/members/{user_id}` returns `roles[]` (which ADR 0002 needs anyway), requires no OAuth scope, 404s cleanly for non-members, never expires, and works in the worker with the user absent.

On first login, upsert a `member` by `discordId` with `displayName`. Discord login *is* proof of Discord identity.

### Steam (optional profile field, exactly one)
A member links Steam so other members can find them in-game. It proves account ownership and yields a SteamID64. It applies **no vetting rule and gates nothing**; a member without one is not "incomplete".

Steam OpenID 2.0, implemented directly (~60 lines), no library:
1. Redirect the logged-in member to `https://steamcommunity.com/openid/login` with `openid.mode=checkid_setup`, `openid.ns=http://specs.openid.net/auth/2.0`, `openid.identity` and `openid.claimed_id` = `http://specs.openid.net/auth/2.0/identifier_select`, `openid.return_to=<PUBLIC_BASE_URL>/link/steam/callback`, `openid.realm=<STEAM_REALM>`.
2. On callback, verify by POSTing the params back with `openid.mode=check_authentication` (Steam does not support associations, so verify statelessly). Require `is_valid:true`.
3. Extract the SteamID64 from `openid.claimed_id` with a **strict** regex `^https://steamcommunity\.com/openid/id/(\d{17})$`.
4. Store `steamId`, `steamVerifiedAt=now`, `steamLinkMethod='openid'`. Enforce uniqueness (one member per Steam64).

### TeamSpeak (one current, replaceable, self-service): pick-from-list + poked code
The member must be connected to TeamSpeak. The worker holds the ServerQuery connection.
1. Member opens "Link TeamSpeak". The web calls the worker over the internal API, `GET /internal/ts/clients` (Compose network only, bearer `WORKER_INTERNAL_TOKEN`). The worker runs `clientList()` and filters to regular clients whose `uid` is not already a `member.tsUid`, returning `{clid, uid, nickname}` (usually one entry). If the worker is down this fails loudly; do not fake an empty list, which would read as "you are not connected to TeamSpeak".
2. Member picks themselves. Web creates a `link_code` row: `{memberId, targetTsUid=uid, code=random, expiresAt=now+5min}`.
3. Web calls `POST /internal/ts/poke` with the `clid` and the code. The worker pokes that client: `clientPoke(clid, "7R link code: <code>, enter it on the website")` (a poke shows even if the bot is hidden in the client tree).
4. Member types the code back on the website. Web verifies an unconsumed, unexpired `link_code` with matching `code` + `targetTsUid`, sets `member.tsUid/tsNickname/tsVerifiedAt/tsLinkMethod='poke'`, and marks the code consumed.
5. Picking the wrong person fails safe: the code goes to that person, not the member, so it can't be completed.

Linking also **backfills guest attendance**: any past `attendance_session` with a matching `ts_uid` and `memberId = null` is attributed to the member on link (§7).

Re-linking (new identity after reinstall) is the same flow; it overwrites the single `tsUid`.

### Admin force-link
An admin sets `tsUid` or `steamId` directly via an admin-gated **slash command** (`/link-force`), with `*LinkMethod='manual'` so it is visibly not self-verified. There is no admin web panel anywhere in this system (ADR 0009).

---

## 5. Role assignment (Discord is the source of truth)

Ranks/roles/badges are Discord roles (ADR 0002). Two ways they change, both writing **Discord**:

1. **Natively in Discord** (admins assign roles in the Discord client): nothing to build.
2. **Bot slash commands** (`apps/web` interactions endpoint), admin-gated by `DISCORD_ADMIN_ROLE_IDS`:
   - `/role add @member <assignable>` / `/role remove @member <assignable>`: add/remove a single Discord role via `PUT` / `DELETE /guilds/{guild}/members/{user}/roles/{role}` (single-role endpoints, so no clobbering), with an `X-Audit-Log-Reason` header. Autocomplete the assignable from the `assignable` table.
   - `/rank set @member <rank>`: enforces **rank exclusivity**: remove any other rank-kind role the member has, then add the chosen one.
   - `/link-force @member <ts_uid|steam_id>`: set an identity link by hand, stamped `manual` so it is visibly not self-verified (§4).
   - `/attendance claim <ts_uid> @member`: attribute a guest attendance session to a member. Rare: linking auto-backfills guests (§7), so this is only for leftovers.
   - Role hierarchy: `7R_Bot`'s highest role must sit above every managed role, and managed (integration) roles are never assignable. Surface a clear error otherwise. Administrator does **not** exempt it from this, and `7R_Bot`'s role was positioned for a `/loa` bot that wrote no roles at all, so assume it is too low until someone has looked (Phase 0).

The platform DB does **not** store per-member role assignments; a member's current Discord roles are the truth. The `assignable` table only holds the definitions/mappings.

Inspection commands (read-only, via REST): `/whohas <assignable>`, `/roles @member`, `/whoismissing <assignable>`, roster export.

**Fetching the member list is a trap.** `GET /guilds/{id}/members` defaults to **`limit=1`**. Always pass `?limit=1000` explicitly and paginate with `after`. Omitting it does not error: the sync silently processes exactly one member and presents as "sync mostly doesn't work". The bot also needs the **GUILD_MEMBERS privileged intent** enabled on the `7R_Bot` application in the developer portal; it is required for the REST member list, not only for the gateway. It is an application toggle rather than a guild permission, so no amount of permission (Administrator included) substitutes for it, it is off by default, and a `/loa` bot had no reason to turn it on. Without it this poll is refused and Phase 3 quietly does nothing.

Bot permissions on `7R_Bot`: `CREATE_EVENTS` (1<<44) + `MANAGE_ROLES`. It currently holds Administrator, so nothing is blocked today; ARCHITECTURE §7 wants that dialled back to these two.

---

## 6. Discord → TeamSpeak sync (worker)

Runs every `ROLE_SYNC_INTERVAL_SECONDS`. One-way, Discord → TeamSpeak. This is the component that pays for the project: TeamSpeak groups are currently maintained **by hand**, and nothing else writes them (the legacy sync was never finished).

**Preconditions:** ServerQuery connected over SSH (login, `useByPort`/select `TS_VIRTUALSERVER_ID`), IP allowlisted so the flood limit doesn't apply. The `assignable` mapping is defined in a **git-tracked config** and applied by a seed task (ADR 0009), never hand-edited as a source of record. The seed resolves every sgid **by group name against a live `servergrouplist`** and prints the proposed name-to-sgid mapping for terminal confirmation before writing; the sgids in the legacy dump are not trusted (MIGRATION.md).

**Owned set:** `owned = { a.tsSgid for a in assignable if a.tsSgid != null }`. The reconcile only ever adds/removes within `owned`. Everything else on TS (Server Admin, Server Query, channel groups, manual grants) is invisible and persists (ADR 0002).

**The loop iterates OUR members, not the guild member list.** This matters: if you loop over the Discord guild members, a member who *leaves* the unit simply vanishes from the poll, is never reconciled, and keeps their TeamSpeak groups forever. Iterating our own DB makes the leaver fall out correctly with no special case: they have no Discord roles, so their desired set is empty, so every owned group is removed on the next pass.

**Per sync:**
1. Poll the guild once: `GET /guilds/{id}/members?limit=1000` (paginate with `after`). Index it as `discordId -> roles[]`. Build `discordRoleId -> assignable` from the DB once.
2. Fetch TS `servergrouplist` once (to validate sgids exist; log any mapped sgid that no longer exists).
3. **For each `member` in OUR database with a non-null `tsUid`:**
   a. Look up that member's Discord roles in the polled index. **Not present in the guild? Roles are `[]`** (they left, or were kicked), and stamp `disabled_at = now` if it is not already set. Do not skip them.
   b. `desired = { assignable.tsSgid for each of the member's Discord roles that maps to an assignable with a non-null tsSgid }` (intersect with `owned`). For a leaver this is the empty set.
   c. Resolve the durable DB id: `cldbid = clientGetDbIdFromUid(tsUid)` (works whether or not they are online).
   d. `current = servergroupsbyclientid(cldbid)` intersected with `owned`.
   e. `toAdd = desired - current`; `toRemove = current - desired`.
4. **Blast-radius guard (before applying anything).** Count the members whose `toRemove` is non-empty. If that count exceeds `SYNC_MAX_REMOVALS` (default 5), **halt the pass, apply nothing**, and post to `ERROR_ALERT_DISCORD_WEBHOOK`. Normal operation touches 0 to 2 people, so a mass removal is definitionally a bug: a bad mapping, an empty Discord poll, TS returning garbage. Additions are never blocked. This is a **standing** guard, not a first-run check: the dry-run protects run #1, this protects run #200.
5. Apply: `serverGroupAddClient(cldbid, sgid)` for each add; `serverGroupDelClient(cldbid, sgid)` for each remove. Never touch sgids outside `owned`.
6. **Rank exclusivity** falls out naturally: if Discord has exactly one rank role, `desired` contains exactly one rank sgid and the others are removed. If a member somehow has >1 rank role in Discord, log a warning (fix it on the Discord side).

**Dry-run:** while `SYNC_DRY_RUN=true`, compute `toAdd`/`toRemove` and print them via the `deno task sync:preview` CLI task **without applying** (ADR 0009: no admin UI). The very first real run will strip mapped groups that don't match Discord, so review the preview, then flip the flag.

**Resilience:** wrap ServerQuery calls; on disconnect, reconnect and re-subscribe (reuse the legacy `removeAllListeners('clientconnect')` guard before re-adding listeners). Respect flood back-off (the library handles 524). Members who are offline still sync (cldbid is durable).

---

## 7. Operations & attendance (worker)

### Weekly event creation
A job on `OP_WEEKLY_CRON` (computed DST-correct in `OP_TIMEZONE`, not a hardcoded UTC hour). **Saturdays only**; there is no Wednesday op.
1. Compute this week's op datetimes from `OP_ATTENDANCE_START/END` and `OP_EVENT_END` in `OP_TIMEZONE`.
2. **Idempotency:** if an `operation` already exists for that date (or the Discord event exists), skip.
3. Create the Discord scheduled event: `POST /guilds/{id}/scheduled-events` with `entity_type=3` (EXTERNAL), `privacy_level=2` (GUILD_ONLY), `entity_metadata.location="TeamSpeak / server"`, `scheduled_start_time` and `scheduled_end_time` as ISO-8601 (event end = 23:30). Needs **`CREATE_EVENTS` (1<<44)**. `MANAGE_EVENTS` (1<<33) is **not** enough: it only edits and deletes events that already exist, and 403s on create.
4. Insert the `operation` row with the event id and the three windows.

The event's native RSVP ("Interested") list is the unit's op-planning tool. We store nothing for it and build no UI for it.

### Attendance sampling
During `[attendanceStart, attendanceEnd]` (20:00 to 23:00 local):
1. Every `ATTENDANCE_SAMPLE_SECONDS` (~90s), `clientList({ cid: TS_OPERATIONS_CHANNEL_CID, clientType: Regular })` gives the set of `{uid, nickname}` present in the Operations channel.
2. Keep an in-memory "currently open sessions by uid". Diff each sample against the previous:
   - uid newly present: open a session (`joinedAt = sampleTime`).
   - uid no longer present: close its session (`leftAt = sampleTime`).
3. At `attendanceEnd`, close all still-open sessions at `attendanceEnd`. Persist `attendance_session` rows.
4. Resolve `tsUid -> member`. Unmatched uids stay guests (`memberId = null`). Guests **auto-backfill**: the moment that person links their TeamSpeak identity (§4), past `attendance_session` rows with the matching `ts_uid` are attributed to them. Any leftover is claimed via an admin slash command (ADR 0009).

### Credit
A member is credited for an op if `sum(min(leftAt, attendanceEnd) - max(joinedAt, attendanceStart))` across their sessions ≥ `ATTENDANCE_MIN_MINUTES` (60). Compute on read; no need to materialize.

### What attendance is for
**Attendance is a statistic and nothing else.** Nobody acts on it. It gates no promotion, triggers no removal, and feeds no process. It shows on a member's own profile and in a read-only site view. Build exactly that and no more. No historical attendance is imported (MIGRATION.md); the counter starts at zero.

This reuses the legacy `record-operation-attendees` approach (sample the Operations channel + diff), at a finer cadence. No Arma-side anything.

---

## 8. Discord interactions endpoint (`apps/web`)

`POST /api/discord/interactions`:
1. Verify the `X-Signature-Ed25519` + `X-Signature-Timestamp` headers against `DISCORD_PUBLIC_KEY` using WebCrypto (`crypto.subtle.verify('Ed25519', …)`) over `timestamp + rawBody`. Native on Deno: no flags, no polyfill.
2. **Read the RAW body bytes before parsing.** Verify over those exact bytes. Never `JSON.parse` and re-stringify; the re-serialisation will not be byte-identical and verification will fail (or, worse, you will be tempted to loosen it).
3. **Verification must FAIL CLOSED: return 401 on *any* exception, never 200.** Wrap the whole verify step so a malformed header, a bad base64 decode, or a thrown `subtle.verify` all end as 401. Discord deliberately sends invalid signatures to test the endpoint and will **remove your interactions URL** if you ever answer one with 200. That is a silent, delayed bot death: nothing errors, the bot just stops receiving commands.
4. Respond to `type:1` (PING) with `type:1` (PONG).
5. Dispatch `type:2` (APPLICATION_COMMAND) to handlers; reply ephemerally where sensible (`flags: 64`). **Respond within 3 seconds** or ack with `type:5` (deferred) and follow up via REST. This matters on a cold container start, so prefer deferring anything that touches TeamSpeak or the guild member list.
6. Register commands once (guild-scoped for instant updates during dev, global for release) with a `deno task register-commands`. **`7R_Bot`'s application is not a blank slate: it may still carry the legacy `/loa`.** List what is there first (`GET /applications/{id}/commands` and `.../guilds/{guild}/commands`), then register deliberately. A bulk `PUT` replaces the whole scope it targets, so it drops a guild-scoped `/loa` for free (which is what we want: there is no LOA in this system, ADR 0010) but cannot touch a global one, which would survive and be routed at our endpoint with no handler behind it.

Setting the Interactions Endpoint URL on the `7R_Bot` application disables gateway `INTERACTION_CREATE` **for that application**, which is fine (there is no gateway anyway, ADR 0003), and takes over interaction delivery for every command it owns, `/loa` included. The legacy bot is untouched by any of this: different account, different token (ADR 0015), and its `!` prefix commands cannot collide with slash commands, so the two coexist safely until the old one is retired.

---

## 9. Worker resilience (must-haves)

- Register a global `unhandledrejection` handler that logs and continues (Deno kills the process by default; a stray error must not drop the TS connection or the sampling loop).
- Reconnect the ServerQuery connection on drop; keepalive to avoid idle timeout.
- Post uncaught errors to `ERROR_ALERT_DISCORD_WEBHOOK` so failures are visible without log-diving.
- Never run migrations on boot; migrations are a separate one-shot `deno task migrate` (ADR 0008).

---

## 10. Build order (maps to ARCHITECTURE phases)

TeamSpeak sync comes early, not last. The site and the old bot already serve; hand-managed TeamSpeak groups are the actual recurring pain, and the content port must not be allowed to stall the useful part.

0. **Prep (no code).** Stand `7R_Bot` up as the platform's Discord application: collect its app id, client secret, bot token and public key into `.env`; enable the GUILD_MEMBERS intent; move its role above every Assignable role; dial its Administrator grant back to `CREATE_EVENTS` + `MANAGE_ROLES`; clear any surviving `/loa`. The 2019 bot's account is not reused (ARCHITECTURE §7, ADR 0015). Harvest the 25 meme images: call `POST /api/v9/attachments/refresh-urls` with a token that can read the messages those attachments live in (`7R_Bot` should qualify; if not, borrow the legacy token locally, once) to get freshly-signed URLs, download, commit to the repo, serve from our own domain (the CDN links hardcoded in the old `fun.py` 404 for anonymous clients). **Create the 8 badge roles in Discord and backfill the 83 legacy grants** (32 members; every legacy user has a Discord id, so it is scriptable), without which badges cannot be Discord-authoritative; this writes Discord roles, so it comes after the bot is set up. Confirm the guild and the GHCR namespace, which do not change.
1. **Foundation.** Monorepo skeleton (Deno workspaces), `config`, `domain`, `db` (Drizzle schema + first migration), Compose with Postgres, CI to GHCR.
2. **Identity (minimal web app).** Discord login (Better Auth), member profile, TeamSpeak linking (pick-from-list + poked code), Steam OpenID linking. No public content yet. **Import the legacy links here** (MIGRATION.md).
3. **TeamSpeak sync.** ServerQuery worker, seed the `assignable` mapping from git config (sgids resolved live, by name), Discord to TS reconcile with `deno task sync:preview` first, then the blast-radius guard. **This is the phase that pays for the project.**
4. **Discord bot.** Interactions endpoint, slash memes, role inspection, `/role` and `/rank set`, `/link-force`, the weekly scheduled-event job (which creates Operations).
5. **Attendance.** Operations-channel sampling, session reconstruction, read-only member/site views, guest auto-backfill on link. No historical import.
6. **Public content.** Public site, branding, handbook (Starlight, no versioning; migrate the 21 `.md` files, move the 103 images to `public/wiki/images/` or rewrite the 96 absolute paths, strip the inline `float:right;width:500px` styles, restore the dropped sections), the stateless briefing generator (SQF byte-for-byte). This replaces the current public site, which serves fine until then.

There is no hardening phase. Backups are cut (ADR/ARCHITECTURE: the only irreplaceable data is ~100 TeamSpeak links) and infrastructure is out of scope (the deliverable is a `compose.yaml`). Log rotation and error-to-Discord alerts fold into the phases that need them.

---

## 11. Testing

**There is no live test environment.** No test Discord guild, no dockerised TeamSpeak server.

What is tested: **pure unit tests over the two pure functions.**
1. The three-way group reconcile (§6): given a member's Discord roles, the `assignable` mapping, and their current TS groups, produce `toAdd` / `toRemove`. Cover the leaver (no roles at all, so everything owned is removed), the unmapped role, the manual TS group outside `owned` (must be untouched), the >1 rank case, and the blast-radius trip.
2. The sample-to-session reconstruction (§7): given an ordered list of channel samples, produce `attendance_session` spans. Cover join, leave, rejoin, present-throughout, and the close-at-`attendanceEnd` case.

Both take plain data in and return plain data out. Keep them that way: the I/O (ServerQuery calls, Discord REST) lives outside them, or this section stops being true.

**The I/O layer is exercised for the first time in production.** That is a deliberate trade-off: standing up a throwaway guild and a TS container is real, ongoing work for one developer in spare time, and would still not test the real server's group ids. The cost is real and worth naming: the first production run *is* the integration test, so a bug in the Discord poll, the ServerQuery calls, or the sgid mapping will be discovered live. That risk is bought down by two things and only two things: `SYNC_DRY_RUN=true` for the first passes (print, apply nothing), and the permanent blast-radius guard (§6) that halts any pass which would remove groups from more than `SYNC_MAX_REMOVALS` members. Neither is optional.

---

## 12. Deno / npm interop gotchas

Learned by running them. Ignoring any one of these costs a day.

**Pin Deno exactly; commit `deno.lock`.** `ts3-nodejs-library` pulls `ssh2`, which uses `node:crypto` for `aes128-gcm@openssh.com`, and a real TeamSpeak server negotiates exactly that cipher. Deno broke that code path three times and only repaired it in February 2026 (denoland/deno#32290). A floating Deno version is a live grenade under the one component that matters.

**Never run `deno approve-scripts` / `--allow-scripts`.** `cpu-features` (a transitive optional dep of `ssh2`) has an install script needing python + node-gyp. The yellow "ignored build scripts" warning is **correct behaviour**, not a problem to fix: the library runs pure-JS with zero native addons and only `--allow-net`.

**Every shared package that `apps/web` consumes needs a `package.json` alongside its `deno.json`.** Astro's bundler cannot resolve a `deno.json`-only workspace member: `Rolldown failed to resolve import "@7r/db"`. The npm/Deno split is *not* contained to `apps/web` (ADR 0006 said it was; it was wrong). Without the dual manifests, the monorepo's only stated benefit, a shared `domain`/`db` layer consumed by both web and worker, does not materialise for the website.

**Build Astro with Deno** (`deno run -A npm:astro build`) and add `RUN deno cache dist/server/entry.mjs` at image-build time, or a cold boot pulls 119 files from jsr.io and a jsr outage kills the container. See §1.

**No Astro session driver.** A full Discord login runs on Deno + Postgres with none configured. Better Auth owns its session table and signed cookie. (You cannot remove the `unstorage` package, Astro hard-depends on it; what you remove is the *config*.)

**Drizzle stays on 0.45.x, pinned.** 1.0 is still RC and will land mid-project. Two guardrails make the eventual upgrade a non-event: do **not** adopt the relational query builder (`.query` / `relations()`), and do **not** use the global `casing` option. The design uses only the core `pgTable` builder, so two of the three v1 breaking changes will not apply and the upgrade shrinks to the migrations-folder restructure.

**drizzle-kit on Deno needs two independent things:** `"nodeModulesDir": "auto"` in `deno.json` **and** `drizzle-kit` declared in `deno.json` `imports`. Having one without the other does not work.

**Apply migrations with the runtime migrator** (`drizzle-orm/postgres-js/migrator`), never `drizzle-kit migrate`, which drags `tsx` and three copies of esbuild into the image. drizzle-kit is a dev-time generator only.
