# 7R Platform: Implementation Guide

The concrete mechanics an implementer needs, beyond the decisions in `docs/adr/` and the shape in `docs/ARCHITECTURE.md`. If something here contradicts an ADR, the ADR wins and this doc is stale. Legacy import specifics are in `docs/MIGRATION.md`.

---

## 1. Stack & pinned choices

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Deno 2 (pin the exact version) | one lockfile; `npm:`/`node:` for gaps |
| Repo | Deno workspaces (`deno.json` `workspace`) | Astro is a `package.json` member (ADR 0006) |
| Web | Astro 7 SSR, `@deno/astro-adapter` (pin, fast-moving 0.x) | run `deno run -A dist/server/entry.mjs`; keep a `node:22` builder stage as insurance |
| Handbook | Starlight + `starlight-versions` | Markdown in `content/handbook/` |
| Auth | Better Auth, Discord social provider | Astro sessions in Postgres via `unstorage` (no auto store on Deno) |
| DB | PostgreSQL, Drizzle ORM + drizzle-kit, `postgres.js` driver | ADR 0008 |
| Discord REST | `@discordjs/rest` (rate-limit queue) or plain `fetch` | no gateway (ADR 0003) |
| Discord interactions | native WebCrypto Ed25519 verify | endpoint in `apps/web` |
| TeamSpeak | `ts3-nodejs-library` (`npm:`), SSH transport (port 10022) | flood 10 cmds / 3s; lib backs off on 524 |
| Reverse proxy | existing nginx + Let's Encrypt on the box | add `web` upstream (ADR 0005) |

---

## 2. Configuration (env / secrets)

All config is parsed in `packages/config` and **fails loud at boot** if a required value is missing. Secrets go through Docker Compose `secrets:` (file-based), never the image.

```
# Core
DATABASE_URL=postgres://…                     # secret
SESSION_SECRET=…                              # secret (Better Auth / cookie signing)
PUBLIC_BASE_URL=https://7th-ranger.com

# Discord
DISCORD_GUILD_ID=305471712546390017
DISCORD_CLIENT_ID=…                           # OAuth (web login)
DISCORD_CLIENT_SECRET=…                        # secret
DISCORD_BOT_TOKEN=…                            # secret — ROTATED (old one was leaked)
DISCORD_PUBLIC_KEY=…                           # for interactions Ed25519 verify
DISCORD_ADMIN_ROLE_IDS=…,…                     # who may run role/admin commands

# Steam (roster/vetting)
STEAM_REALM=https://7th-ranger.com
# (Steam OpenID is stateless; no API key required for login. Optional STEAM_WEB_API_KEY for profile display.)

# TeamSpeak ServerQuery
TS_QUERY_HOST=ts.7th-ranger.com
TS_QUERY_PORT=10022                            # SSH query
TS_QUERY_USER=…                                # secret
TS_QUERY_PASS=…                                # secret
TS_VIRTUALSERVER_ID=1
TS_OPERATIONS_CHANNEL_CID=…                    # the single Operations channel
TS_BOT_NICKNAME=7R Bot

# Ops schedule / attendance
OP_TIMEZONE=Europe/Amsterdam
OP_WEEKLY_CRON=0 20 * * 6                       # Sat 20:00 local (compute DST-correct)
OP_ATTENDANCE_START=20:00
OP_ATTENDANCE_END=23:00
OP_EVENT_END=23:30
ATTENDANCE_MIN_MINUTES=60
ATTENDANCE_SAMPLE_SECONDS=90

# Sync
ROLE_SYNC_INTERVAL_SECONDS=300
SYNC_DRY_RUN=true                              # start true; flip after first preview looks right

# Ops
ERROR_ALERT_DISCORD_WEBHOOK=…                  # secret; worker posts its own errors here
```

---

## 3. Data model (Drizzle sketch)

Defined in `packages/db/schema.ts`. Illustrative, not final. IDs are app-generated (uuid or bigint identity); external IDs are stored as `text` (Discord/TS/Steam snowflakes exceed JS number range).

```ts
// member: the person / hub
member = pgTable('member', {
  id: uuid().primaryKey().defaultRandom(),
  discordId: text('discord_id').notNull().unique(),         // required: the login + role source
  displayName: text('display_name').notNull(),
  disabledAt: timestamp('disabled_at'),
  // TeamSpeak: one current, replaceable
  tsUid: text('ts_uid').unique(),
  tsNickname: text('ts_nickname'),
  tsVerifiedAt: timestamp('ts_verified_at'),
  tsLinkMethod: text('ts_link_method'),                     // 'poke' | 'manual' | 'legacy_import'
  // Steam: exactly one, roster/vetting only
  steamId: text('steam_id').unique(),
  steamVerifiedAt: timestamp('steam_verified_at'),
  steamLinkMethod: text('steam_link_method'),               // 'openid' | 'manual'
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

// assignable: rank | role | badge, and its mapping. Discord is authoritative (ADR 0002).
assignable = pgTable('assignable', {
  id: uuid().primaryKey().defaultRandom(),
  kind: text().notNull(),                                    // 'rank' | 'role' | 'badge'
  name: text().notNull(),
  discordRoleId: text('discord_role_id').notNull().unique(),
  tsSgid: integer('ts_sgid'),                                // nullable; null = not mirrored to TS
  category: text(),
  sortOrder: integer('sort_order').default(0),
})

// operation: one op. The weekly job creates the row + the Discord event together.
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

// loa: leave of absence (real FK this time, not the legacy bare string)
loa = pgTable('loa', {
  id: uuid().primaryKey().defaultRandom(),
  memberId: uuid('member_id').notNull().references(() => member.id),
  date: date().notNull(),
})
```

Better Auth manages its own auth/session tables. Do not model users there; `member` is the domain record, keyed by `discordId`, and links to the auth identity by Discord id.

Ranks are **mutually exclusive** (a member holds one rank); roles and badges are additive. This is enforced on the Discord side (see §5), not by a DB constraint.

---

## 4. Identity linking flows

### Discord (login, the hub)
Better Auth Discord provider, OAuth2 authorization-code. Scopes: `identify` (+ `guilds.members.read` if the site reads the user's own roles without the bot). On first login, upsert a `member` by `discordId` with `displayName`. Discord login *is* proof of Discord identity.

### Steam (roster/vetting, exactly one)
Steam OpenID 2.0, implemented directly (~60 lines), no library:
1. Redirect the logged-in member to `https://steamcommunity.com/openid/login` with `openid.mode=checkid_setup`, `openid.ns=http://specs.openid.net/auth/2.0`, `openid.identity` and `openid.claimed_id` = `http://specs.openid.net/auth/2.0/identifier_select`, `openid.return_to=<PUBLIC_BASE_URL>/link/steam/callback`, `openid.realm=<STEAM_REALM>`.
2. On callback, verify by POSTing the params back with `openid.mode=check_authentication` (Steam does not support associations, so verify statelessly). Require `is_valid:true`.
3. Extract the SteamID64 from `openid.claimed_id` with a **strict** regex `^https://steamcommunity\.com/openid/id/(\d{17})$`.
4. Store `steamId`, `steamVerifiedAt=now`, `steamLinkMethod='openid'`. Enforce uniqueness (one member per Steam64).

### TeamSpeak (one current, replaceable, self-service): pick-from-list + poked code
The member must be connected to TeamSpeak. The worker holds the ServerQuery connection.
1. Member opens "Link TeamSpeak". The web asks the worker for **currently-online, unlinked** clients: `clientList()` filtered to regular clients whose `uid` is not already a `member.tsUid`. Return `{clid, uid, nickname}` (usually one entry).
2. Member picks themselves. Web creates a `link_code` row: `{memberId, targetTsUid=uid, code=random, expiresAt=now+5min}`.
3. Worker pokes that client: `clientPoke(clid, "7R link code: <code> — enter it on the website")` (a poke shows even if the bot is hidden in the client tree).
4. Member types the code back on the website. Web verifies an unconsumed, unexpired `link_code` with matching `code` + `targetTsUid`, sets `member.tsUid/tsNickname/tsVerifiedAt/tsLinkMethod='poke'`, and marks the code consumed.
5. Picking the wrong person fails safe: the code goes to that person, not the member, so it can't be completed.

Re-linking (new identity after reinstall) is the same flow; it overwrites the single `tsUid`.

### Admin force-link
An admin can set `tsUid` or `steamId` directly via an admin-gated slash command (`/link-force`), with `*LinkMethod='manual'` so it's visibly not self-verified. There is no admin web panel (ADR 0009).

---

## 5. Role assignment (Discord is the source of truth)

Roles/ranks/badges are Discord roles (ADR 0002). Two ways they change, both writing **Discord**:

1. **Natively in Discord** (admins assign roles in the Discord client) — nothing to build.
2. **Bot slash commands** (`apps/web` interactions endpoint), admin-gated by `DISCORD_ADMIN_ROLE_IDS`:
   - `/role add @member <assignable>` / `/role remove @member <assignable>` — add/remove a single Discord role via `PUT` / `DELETE /guilds/{guild}/members/{user}/roles/{role}` (single-role endpoints, so no clobbering), with an `X-Audit-Log-Reason` header. Autocomplete the assignable from the `assignable` table.
   - `/rank set @member <rank>` — enforces **rank exclusivity**: remove any other rank-kind role the member has, then add the chosen one.
   - Role hierarchy: the bot's highest role must sit above every managed role, and managed (integration) roles are never assignable. Surface a clear error otherwise.

The platform DB does **not** store per-member role assignments; a member's current Discord roles are the truth. The `assignable` table only holds the definitions/mappings.

Inspection commands (read-only, via REST): `/whohas <assignable>`, `/roles @member`, `/whoismissing <assignable>`, roster export. Fetch members with `GET /guilds/{id}/members?limit=1000` (paginate with `after`); the bot needs the GUILD_MEMBERS intent enabled in the developer portal.

---

## 6. Discord → TeamSpeak sync (worker)

Runs every `ROLE_SYNC_INTERVAL_SECONDS`. One-way, Discord → TeamSpeak.

**Preconditions:** ServerQuery connected (login, `useByPort`/select `TS_VIRTUALSERVER_ID`), IP allowlisted so the flood limit doesn't apply. The `assignable` mapping is defined in a **git-tracked config** and applied by a seed task (ADR 0009), never hand-edited as a source of record.

**Owned set:** `owned = { a.tsSgid for a in assignable if a.tsSgid != null }`. The reconcile only ever adds/removes within `owned`. Everything else on TS (Server Admin, Server Query, channel groups, manual grants) is invisible and persists (ADR 0002).

**Per sync:**
1. `members = GET /guilds/{id}/members` (paginated). Build `discordRoleId -> assignable` from the DB once.
2. Fetch TS `servergrouplist` once (to validate sgids exist; log any mapped sgid that no longer exists — see the stale-sgid caveat in MIGRATION.md).
3. For each `member` with a linked `tsUid`:
   a. `desired = { assignable.tsSgid for each of the member's Discord roles that maps to an assignable with a non-null tsSgid }` (intersect with `owned`).
   b. Resolve the durable DB id: `cldbid = clientGetDbIdFromUid(tsUid)` (works whether or not they're online).
   c. `current = servergroupsbyclientid(cldbid)` intersected with `owned`.
   d. `toAdd = desired - current`; `toRemove = current - desired`.
   e. Apply: `serverGroupAddClient(cldbid, sgid)` for each add; `serverGroupDelClient(cldbid, sgid)` for each remove. Never touch sgids outside `owned`.
4. **Rank exclusivity** falls out naturally: if Discord has exactly one rank role, `desired` contains exactly one rank sgid and the others are removed. If a member somehow has >1 rank role in Discord, log a warning (fix it on the Discord side).

**Dry-run:** while `SYNC_DRY_RUN=true`, compute `toAdd`/`toRemove` and print them via the `deno task sync:preview` CLI task **without applying** (ADR 0009: no admin UI). The very first real run will strip mapped groups that don't match Discord, so review the preview first, then flip the flag.

**Resilience:** wrap ServerQuery calls; on disconnect, reconnect and re-subscribe (reuse the legacy `removeAllListeners('clientconnect')` guard before re-adding listeners). Respect flood back-off (the library handles 524). Members who are offline still sync (cldbid is durable).

---

## 7. Operations & attendance (worker)

### Weekly event creation
A job on `OP_WEEKLY_CRON` (computed DST-correct in `OP_TIMEZONE`, not a hardcoded UTC hour):
1. Compute this week's op datetimes from `OP_ATTENDANCE_START/END` and `OP_EVENT_END` in `OP_TIMEZONE`.
2. **Idempotency:** if an `operation` already exists for that date (or the Discord event exists), skip.
3. Create the Discord scheduled event: `POST /guilds/{id}/scheduled-events` with `entity_type=3` (EXTERNAL), `privacy_level=2` (GUILD_ONLY), `entity_metadata.location="TeamSpeak / server"`, `scheduled_start_time` and `scheduled_end_time` as ISO-8601 (event end = 23:30). Needs the **Manage Events** permission.
4. Insert the `operation` row with the event id and the three windows.

### Attendance sampling
During `[attendanceStart, attendanceEnd]` (20:00–23:00 local):
1. Every `ATTENDANCE_SAMPLE_SECONDS` (~90s), `clientList({ cid: TS_OPERATIONS_CHANNEL_CID, clientType: Regular })` → the set of `{uid, nickname}` present in the Operations channel.
2. Keep an in-memory "currently open sessions by uid". Diff each sample against the previous:
   - uid newly present → open a session (`joinedAt = sampleTime`).
   - uid no longer present → close its session (`leftAt = sampleTime`).
3. At `attendanceEnd`, close all still-open sessions at `attendanceEnd`. Persist `attendance_session` rows.
4. Resolve `tsUid -> member`. Unmatched uids stay guests (`memberId = null`). Guests auto-resolve when that person later links the TeamSpeak identity: on link, backfill past `attendance_session` rows with the matching `ts_uid` to the member. Any leftover is claimed via an admin slash command (ADR 0009).

### Credit
A member is credited for an op if `sum(min(leftAt, attendanceEnd) - max(joinedAt, attendanceStart))` across their sessions ≥ `ATTENDANCE_MIN_MINUTES` (60). Compute on read; no need to materialize.

This reuses the legacy `record-operation-attendees` approach (sample the Operations channel + diff), at a finer cadence. No Arma-side anything.

---

## 8. Discord interactions endpoint (`apps/web`)

`POST /api/discord/interactions`:
1. Verify the `X-Signature-Ed25519` + `X-Signature-Timestamp` headers against `DISCORD_PUBLIC_KEY` using WebCrypto (`crypto.subtle.verify('Ed25519', …)`) over `timestamp + rawBody`. Reject with 401 on failure. **Read the raw body before parsing** (verification is over exact bytes).
2. Respond to `type:1` (PING) with `type:1` (PONG).
3. Dispatch `type:2` (APPLICATION_COMMAND) to handlers; reply ephemerally where sensible (`flags: 64`). For anything slow, ack with `type:5` (deferred) and follow up via REST.
4. Register commands once (guild-scoped for instant updates during dev, global for release) with a `deno task register-commands`.

Setting the Interactions Endpoint URL disables gateway `INTERACTION_CREATE`, which is fine (there is no gateway anyway, ADR 0003).

---

## 9. Worker resilience (must-haves)

- Register a global `unhandledrejection` handler that logs and continues (Deno kills the process by default; a stray error must not drop the TS connection or the sampling loop).
- Reconnect the ServerQuery connection on drop; keepalive to avoid idle timeout.
- Post uncaught errors to `ERROR_ALERT_DISCORD_WEBHOOK` so failures are visible without log-diving.
- Never run migrations on boot; migrations are a separate one-shot `deno task migrate` (ADR 0008).

---

## 10. Build order (maps to ARCHITECTURE §9 phases)

1. `config` + `db` (schema + first migration) + Compose/Postgres.
2. Public site + handbook + briefing generator.
3. Better Auth login + member area + Steam/TeamSpeak linking + **legacy import** (MIGRATION.md).
4. Interactions endpoint + meme/role commands + weekly event job.
5. TS sync (seed `assignable` from the import; dry-run first).
6. Attendance sampling + views + import historical attendance.
7. Hardening.
