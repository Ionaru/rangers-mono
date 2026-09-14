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
| Discord REST | plain `fetch`, one hand-rolled helper (auth headers, 429 handling, a bounded transient retry) | **not** `@discordjs/rest`: 9 transitive deps incl. a second HTTP stack, to buy rate-limit bucketing worth nothing at ~1 request / 3 min. It does carry its own bounded retry for 429s, transient 5xx and Cloudflare 52x, which is a loop and not a dependency. `discord-api-types` as a types-only dev dep if the enums are wanted. No gateway (ADR 0003) |
| Discord interactions | native WebCrypto Ed25519 verify | zero flags, no polyfill. Endpoint in `apps/web` |
| TeamSpeak | `ts3-nodejs-library` (`npm:`), SSH transport (port 10022) | verified working under Deno end to end: pure-JS crypto, zero native addons, only `--allow-net`. Flood 10 cmds / 3s, and the library's 524 handling is **not** a back-off: it re-sends the same command every second forever, so we pace ourselves instead (§6, `packages/teamspeak/throttle.ts`) |
| Logging | `@logtape/logtape` (pinned), wrapped by `packages/logging` | zero dependencies, resolves `Deno.inspect` natively. JSON lines in both services, `LOG_LEVEL` sets the floor, `getLogger` at module scope and `configureLogging` at entry points only (ADR 0019) |
| Reverse proxy | existing nginx + Let's Encrypt on the box | add `web` upstream (ADR 0005) |

The Astro runtime image ships **no `node_modules`**. Building with `npx astro build` instead produces an artifact that dies at boot (`error: Import "unstorage" not a dependency`) unless ~276 MB of `node_modules` is copied into the runtime image. There is no Node builder stage.

---

## 2. Configuration (env / secrets)

All config is parsed in `packages/config` and **fails loud at boot** if a required value is missing.

The database password and URL are file-based Docker Compose `secrets:`, mounted at `/run/secrets/*`. Every other value, secret or not, reaches `web` and `worker` as plain environment from a `.env` on the box, which Compose loads with `env_file:` (ADR 0014). Nothing is ever baked into an image. For any key `X`, a mounted `X_FILE` **beats** a directly-set `X`.

**The box `.env` is generated at deploy, not hand-maintained (ADR 0018).** Production config lives in the GitHub **`production` Environment**: non-secret values as **variables** (viewable/editable in the UI), credentials as **secrets** (write-only), each named exactly as its `.env` key. The deploy assembles `.env` from `toJSON(vars)` + `toJSON(secrets)` (excluding the operational `DEPLOY_*`/`GITHUB_TOKEN`) and writes it to the box. So: **change a value** = edit the one variable/secret; **add a key** = add one entry, no `cd.yaml` change; do not hand-edit the box `.env` (it is overwritten each deploy). `.env.example` tags each key `[VAR]`/`[SECRET]`. **`deno task env:check`** (a read-only doctor over the same schemas; the deploy runs it as a gate) names any missing-required key before it reaches production. `DATABASE_URL` stays out of GitHub, supplied on the box by `DATABASE_URL_FILE`.

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

# TeamSpeak ServerQuery (needed from PHASE 2, not Phase 4: the poke-link flow
# needs a live connection to list online clients and poke one of them)
TS_QUERY_HOST=ts.7th-ranger.com
TS_QUERY_PORT=10022                            # SSH query; mandatory, the host is on the public internet
TS_QUERY_USER=…                                # secret
TS_QUERY_PASS=…                                # secret
TS_VIRTUALSERVER_ID=1
TS_BOT_NICKNAME=7R Bot                         # the ServerQuery client's nickname, set on connect
TS_OPERATIONS_CHANNEL_CID=…                    # the single Operations channel. PHASE 6 (attendance) only:
                                               # kept out of the group above so the link flow does not
                                               # demand a channel id it never reads. REQUIRED from Phase 6:
                                               # the worker fails loud at boot without it, so add it to the
                                               # GitHub `production` Environment BEFORE deploying Phase 6.
                                               # `deno task attendance:preview` prints the channel's NAME
                                               # next to the id, which is the only way to eyeball it

# Internal web -> worker API (Compose network only; never proxied, never public)
WORKER_INTERNAL_URL=http://worker:8080
WORKER_INTERNAL_TOKEN=…                          # secret; shared between web and worker

# Ops schedule / attendance
OP_TIMEZONE=Europe/Amsterdam
OP_ATTENDANCE_START=20:00
OP_ATTENDANCE_END=23:00
OP_EVENT_END=23:30
ATTENDANCE_MIN_MINUTES=60
ATTENDANCE_SAMPLE_SECONDS=90
ATTENDANCE_RSVP_REFRESH_SECONDS=900            # how often the event's Interested list is captured

# Weekly event creation + announcement (Phase 5). OP_ANNOUNCE_CHANNEL_ID is REQUIRED:
# the worker fails loud at boot without it. The rest have defaults.
OP_ANNOUNCE_CHANNEL_ID=…                        # the #arma_general channel id
OP_ANNOUNCE_WEEKDAY=3                           # 0=Sun .. 6=Sat; 3 = Wednesday
OP_ANNOUNCE_TIME=18:00                          # local time on that weekday to fire
OP_PREP_CHANNEL_ID=…                            # optional; the mission-maker channel pinged a day early. Unset = no prep step
OP_PREP_MENTION_ROLE_ID=…                        # optional; the Mission maker role mentioned in that ping
OP_PREP_LEAD_DAYS=1                             # days before the announce moment, same local time
OP_ANNOUNCE_TEXT_PATH=…                         # optional; blank-line-separated witty messages (may be multi-line), one picked at random
OP_ANNOUNCE_IMAGE_DIR=…                         # optional; random PNG/JPG/GIF as the event cover banner
OP_EVENT_DRY_RUN=true                           # start true; flip to false to go live (first live pass pings @everyone)

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
  preparedAt: timestamp('prepared_at'),                     // mission makers pinged to fill the event in
  announcedAt: timestamp('announced_at'),                   // @everyone posted
  lastSampleAt: timestamp('last_sample_at'),                // sampler liveness AND the restart close-at instant
  rsvpRefreshedAt: timestamp('rsvp_refreshed_at'),          // pacing marker for the Interested-list capture
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

// operation_rsvp: one Discord account on the event's "Interested" list while the op ran (ADR 0020).
// No member_id: the join to member.discord_id happens on READ, so somebody who first signs
// in a month after an op is still matched against it and nothing needs backfilling.
operationRsvp = pgTable('operation_rsvp', {
  id: uuid().primaryKey().defaultRandom(),
  operationId: uuid('operation_id').notNull().references(() => operation.id, { onDelete: 'cascade' }),
  discordId: text('discord_id').notNull(),
  username: text('username'),                               // snapshot, for responders who are not members
  firstSeenAt: timestamp('first_seen_at').notNull(),
  lastSeenAt: timestamp('last_seen_at').notNull(),
}, (t) => [uniqueIndex().on(t.operationId, t.discordId)])   // the upsert target for each refresh

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

On first login, upsert a `member` by `discordId` with `displayName`. Discord login *is* proof of Discord identity. (A first `/link` in Discord upserts the same way: the interaction arriving from inside the guild is the guild gate. Two creation paths, one key: `discordId`. See below and ADR 0017.)

### Steam (optional profile field, exactly one)
A member links Steam so other members can find them in-game. It proves account ownership and yields a SteamID64. It applies **no vetting rule and gates nothing**; a member without one is not "incomplete".

Steam OpenID 2.0, implemented directly (~60 lines), no library:
1. Redirect the logged-in member to `https://steamcommunity.com/openid/login` with `openid.mode=checkid_setup`, `openid.ns=http://specs.openid.net/auth/2.0`, `openid.identity` and `openid.claimed_id` = `http://specs.openid.net/auth/2.0/identifier_select`, `openid.return_to=<PUBLIC_BASE_URL>/link/steam/callback`, `openid.realm=<STEAM_REALM>`.
2. On callback, verify by POSTing the params back with `openid.mode=check_authentication` (Steam does not support associations, so verify statelessly). Require `is_valid:true`.
3. Extract the SteamID64 from `openid.claimed_id` with a **strict** regex `^https://steamcommunity\.com/openid/id/(\d{17})$`.
4. Store `steamId`, `steamVerifiedAt=now`, `steamLinkMethod='openid'`. Enforce uniqueness (one member per Steam64).

### TeamSpeak (one current, replaceable, self-service): `/link` in Discord, pick-from-list + poked code
The member must be connected to TeamSpeak. The worker holds the ServerQuery connection; the `/link` handlers run in the interactions endpoint (`apps/web`, §8) and reach it over the internal API. This flow replaces the Phase 2 web link pages, which were removed when it shipped (ADR 0017); the profile page now shows the link's status and points at the command.
1. Member runs `/link`. The handler defers ephemerally (this hits the worker, so it cannot fit in 3 seconds on a cold start), upserts the `member` by `discordId` if missing (the interaction comes from inside the guild, which is the guild gate), then calls `GET /internal/ts/clients?member=<id>` (Compose network only, bearer `WORKER_INTERNAL_TOKEN`). The worker runs `clientList()` and hides identities already linked to **another** member, but offers the requester their **own** current identity back, marked as such: re-linking means picking the identity you already hold, and hiding it was a real bug (a linked member saw an empty list). The decision is `pickableClients` in `@7r/identity`, pure and tested. It returns `{clid, uid, nickname, current}` (usually one entry). The endpoint edits `@original` into an **ephemeral message** (`flags: 64`) carrying a String Select of those nicknames, the current one flagged in its option description. If the worker is down this fails loudly; do not fake an empty list, which would read as "you are not connected to TeamSpeak".
2. Member picks themselves (a `MESSAGE_COMPONENT` interaction). The handler re-fetches the client list to resolve the ephemeral `clid` against the durable `uid`, creates a `link_code` row `{memberId, targetTsUid=uid, code=random, expiresAt=now+5min}`, calls `POST /internal/ts/poke` with the `clid` and the code (the worker pokes that client: `clientPoke(clid, "7R link code: <code>")`, the code and nothing else, because the member is already looking at the command that asked for it and the web pages that were the other possible destination are gone; a poke shows even if the bot is hidden in the client tree), and **updates the ephemeral message** to "code sent to *nickname*" with an **[Enter code] button**.
3. Member clicks the button; the response is a **modal** (type 9) whose single text input is wrapped in a **Label** component (type 18), not an Action Row: Discord deprecated Action-Row-wrapped text inputs in modals. The button stays on the message: a dismissed modal or a wrong code is recovered by clicking it again, since the bot cannot reopen a modal on its own.
4. Member submits the code (a `MODAL_SUBMIT` interaction). The handler defers an ephemeral reply (type 5), verifies an unconsumed, unexpired `link_code` with matching `code` + `targetTsUid`, sets `member.tsUid/tsNickname/tsVerifiedAt/tsLinkMethod='poke'`, marks the code consumed, and edits `@original` with the outcome (attempts remaining on a wrong code). It answers with a fresh ephemeral reply, **not** an `UPDATE_MESSAGE`: type 6 and 7 are documented "only valid for component-based interactions" and Discord documents neither for a modal submit, so relying on one in a flow first exercised in production is not worth the risk. The picker message and its `[Enter code]` button are left intact for a retry.
5. Picking the wrong person fails safe: the code goes to that person, not the member, so it can't be completed.

Linking also **backfills guest attendance**: any past `attendance_session` with a matching `ts_uid` and `memberId = null` is attributed to the member on link (§7).

Re-linking is the same flow, and it covers two cases: a **new** identity after a reinstall (it overwrites the single `tsUid`), and **re-picking the identity you already hold**, which re-stamps `tsVerifiedAt` and `tsLinkMethod='poke'`. The second is how a `legacy_import` or `manual` link upgrades itself to a verified `poke` link, and it is exactly the pick that was impossible before the requester's own identity was offered back. `/unlink` clears the link (`tsUid/tsNickname/tsVerifiedAt/tsLinkMethod = null`); past attendance stays attributed. Both commands are member-facing and **not** admin-gated, unlike every other write command (§5).

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
   - `/attendance claim <ts_uid> @member`: attribute a guest attendance session to a member. Rare: linking auto-backfills guests (§7), so this is only for leftovers. **Built (Phase 6), and it was the first of its kind twice over**: the first admin-gated command, and the first command with arguments at all, so it added an `options` field to `CommandDefinition` and to `InteractionData` plus the two readers (`subcommandOf`, `optionValue`) that every later command with arguments will use. The admin check reads `interaction.member.roles`, so it costs no REST call.
   - Role hierarchy: `7R_Bot`'s highest role must sit above every managed role, and managed (integration) roles are never assignable. Surface a clear error otherwise. Administrator does **not** exempt it from this, and `7R_Bot`'s role was positioned for a `/loa` bot that wrote no roles at all, so assume it is too low until someone has looked (Phase 0). **Somebody has now looked, and it is: measured 2026-07-14, its highest role is at position 28, below Officer (30) and NCO (29).** So every write to those two 403s while the bot looks perfectly healthy. It does outrank the other six. `deno task phase0:check` re-checks it.

The platform DB does **not** store per-member role assignments; a member's current Discord roles are the truth. The `assignable` table only holds the definitions/mappings.

Inspection commands (read-only, via REST): `/whohas <assignable>`, `/roles @member`, `/whoismissing <assignable>`, roster export.

**Fetching the member list is a trap.** `GET /guilds/{id}/members` defaults to **`limit=1`**. Always pass `?limit=1000` explicitly and paginate with `after`. Omitting it does not error: the sync silently processes exactly one member and presents as "sync mostly doesn't work". The bot also needs the **GUILD_MEMBERS privileged intent** enabled on the `7R_Bot` application in the developer portal; it is required for the REST member list, not only for the gateway. It is an application toggle rather than a guild permission, so no amount of permission (Administrator included) substitutes for it, it is off by default, and a `/loa` bot had no reason to turn it on. Without it this poll is refused and Phase 4 quietly does nothing.

Bot permissions on `7R_Bot`: `CREATE_EVENTS` (1<<44) + `MANAGE_ROLES` at the guild level, plus, in #arma_general only, **Send Messages + Mention @everyone** (for the weekly announcement to ping) and **Read Message History** (so it can dedup its own prior post and never double-ping). **Measured 2026-07-14 (`deno task phase0:check`): it held `MANAGE_ROLES` and NOT Administrator, and was missing `CREATE_EVENTS`.** The long-standing claim that it holds Administrator was wrong, so the outstanding task was to *add* `CREATE_EVENTS`, not to take anything away. **That is no longer outstanding:** three consecutive ops (2026-08-29 onward) carry a `discord_event_id`, so creation works today. Which of `CREATE_EVENTS` or Administrator is supplying it, only `phase0:check` can say. Miss the grant entirely and the weekly event 403s on create, silently, which is why this is worth re-checking rather than assuming either way.

---

## 6. Discord → TeamSpeak sync (worker)

Runs every `ROLE_SYNC_INTERVAL_SECONDS`. One-way, Discord → TeamSpeak. This is the component that pays for the project: TeamSpeak groups are currently maintained **by hand**, and nothing else writes them (the legacy sync was never finished).

**Preconditions:** ServerQuery connected over SSH (login, `useByPort`/select `TS_VIRTUALSERVER_ID`). IP allowlisting the query login lifts TeamSpeak's flood limit and is still worth doing, but it is **not** a precondition and the reconcile must not assume it: it was not in force when Phase 4 went live, nothing in the codebase can tell whether it is, and the worker paces itself below the limit either way (`packages/teamspeak/throttle.ts`). The `assignable` mapping is defined in a **git-tracked config** and applied by a seed task (ADR 0009), never hand-edited as a source of record. The seed resolves every sgid **by group name against a live `servergrouplist`** and prints the proposed name-to-sgid mapping for terminal confirmation before writing; the sgids in the legacy dump are not trusted (MIGRATION.md).

**Owned set:** `owned = { a.tsSgid for a in assignable if a.tsSgid != null }`. The reconcile only ever adds/removes within `owned`. Everything else on TS (Server Admin, Server Query, channel groups, manual grants) is invisible and persists (ADR 0002).

**The loop iterates OUR members, not the guild member list.** This matters: if you loop over the Discord guild members, a member who *leaves* the unit simply vanishes from the poll, is never reconciled, and keeps their TeamSpeak groups forever. Iterating our own DB makes the leaver fall out correctly with no special case: they have no Discord roles, so their desired set is empty, so every owned group is removed on the next pass.

**Per sync:**
1. Poll the guild once: `GET /guilds/{id}/members?limit=1000` (paginate with `after`). Index it as `discordId -> roles[]`. Build `discordRoleId -> assignable` from the DB once. Transient Discord failures (5xx, Cloudflare 52x, a dead connection) are retried inside the REST helper before the pass is allowed to fail; that is a retry, not rate-limit bucketing: one bounded loop in `packages/discord/rest.ts`, no dependency (ADR 0003).
2. Fetch TS `servergrouplist` once (to validate sgids exist; log any mapped sgid that no longer exists).
3. **Read the membership of each owned group once: `servergroupclientlist <sgid> -names`, one command per group.** That is ~15 commands whatever the roster does, where asking per member was 2 each and ~200 a pass, which is the difference between pacing comfortably under TeamSpeak's flood limit and sitting on top of it for minutes (see **Do not rely on the library's flood back-off** below). The `-names` flag is load-bearing: it returns the identity **and** the durable `cldbid` in the same response, so nobody who holds a group needs a second lookup. Index it as `tsUid -> { cldbid, owned sgids held }`.
   - **A group that fails to read is not an empty group.** Read as empty, every holder would diff to "should not have it". Drop that sgid from the mapping for the pass instead, which removes it from `desired` and `current` together: nobody gains or loses it, the other groups reconcile normally, and the next tick tries again. If no owned group can be read, abort the pass.
   - An identity the lists describe inconsistently (two client ids for one uid, or one client id under two uids) is dropped rather than guessed at: that is what a mis-parsed response looks like, and acting on it writes groups to the wrong person.
4. **For each `member` in OUR database with a non-null `tsUid`:**
   a. Look up that member's Discord roles in the polled index. **Not present in the guild? Roles are `[]`** (they left, or were kicked), and stamp `disabled_at = now` if it is not already set. Do not skip them.
   b. `desired = { assignable.tsSgid for each of the member's Discord roles that maps to an assignable with a non-null tsSgid }` (intersect with `owned`). For a leaver this is the empty set.
   c. `current` = the owned groups the index says their `tsUid` holds. Absent from every list means they hold none of them: a positive answer, because the lists are complete for the groups this pass is willing to touch.
   d. Their `cldbid` came with the group lists. The exception is a member who holds no owned group but is due one, whose adds have nowhere to land: for those, and only those, fall back to `clientGetDbIdFromUid(tsUid)` (works whether or not they are online). A removal never needs it, because holding a group is what puts them in a list. If that fallback fails, plan no group ops for them at all, and let their `disabled_at` still follow Discord.
   e. `toAdd = desired - current`; `toRemove = current - desired`.
5. **Blast-radius guard (before applying anything).** Count the members whose `toRemove` is non-empty. If that count exceeds `SYNC_MAX_REMOVALS` (default 5), **halt the pass, apply nothing**, and post to `ERROR_ALERT_DISCORD_WEBHOOK`. Normal operation touches 0 to 2 people, so a mass removal is definitionally a bug: a bad mapping, an empty Discord poll, TS returning garbage. Additions are never blocked. This is a **standing** guard, not a first-run check: the dry-run protects run #1, this protects run #200.
6. Apply: `serverGroupAddClient(cldbid, sgid)` for each add; `serverGroupDelClient(cldbid, sgid)` for each remove. Never touch sgids outside `owned`.
7. **Rank exclusivity** falls out naturally: if Discord has exactly one rank role, `desired` contains exactly one rank sgid and the others are removed. If a member somehow has >1 rank role in Discord, log a warning (fix it on the Discord side).

**Dry-run:** while `SYNC_DRY_RUN=true`, compute `toAdd`/`toRemove` and print them via the `deno task sync:preview` CLI task **without applying** (ADR 0009: no admin UI). The very first real run will strip mapped groups that don't match Discord, so review the preview, then flip the flag.

**Resilience:** wrap ServerQuery calls; on disconnect, reconnect and re-subscribe (reuse the legacy `removeAllListeners('clientconnect')` guard before re-adding listeners). Members who are offline still sync (cldbid is durable).

**Do not rely on the library's flood back-off.** It handles 524 by re-sending the same command about a second later, forever, with no backoff and no attempt counter, so a burst does not fail: it silently degrades to roughly one command per second and holds the connection (and therefore the link flow) for as long as it takes to drain. The worker keeps itself under the limit instead, with a sliding window in front of every command the process sends (`packages/teamspeak/throttle.ts`). Cost of pacing: a pass reports the milliseconds it spent waiting, because removing the flood also removes the log line that used to announce the pressure.

**A failed pass is not news; a run of them is.** Every failure is logged immediately, but the error webhook waits for failures to accumulate before paging, because Discord's transient 5xx and Cloudflare's 52x had already fixed themselves by the next tick every time they appeared. A leaky bucket, not a strict run: a failure adds one, a clean pass takes one away, and it pages at three. A single blip drains away unheard; a fault that fails two passes in three still reaches the threshold instead of hiding behind the successes forever. A 401 or 403 pages at once: those are a revoked token or the GUILD_MEMBERS intent, and they will not fix themselves. A pass that hangs is neither, so the loop also pages when it has skipped three consecutive ticks behind a pass that never returned.

---

## 7. Operations & attendance (worker)

### Weekly event creation
A **reconciler**, not a fire-once cron (`apps/worker/weekly-event.ts`): every ~5 minutes it recomputes, DST-correct in `OP_TIMEZONE`, the coming Saturday's op and this week's prep and announce moments (the pure `planWeeklyOp` in `@7r/domain`), and inside the window ensures the event, row, mission-maker ping and announcement exist. Recomputing a pure function of the clock each tick is what makes it survive restarts and missed ticks, where a fixed UTC cron would drift an hour across a DST change and would not recover a tick it slept through. **The op is still Saturday-only**; the *announcement* fires on the announce weekday before it (default **Wednesday 18:00 local**, `OP_ANNOUNCE_WEEKDAY`/`OP_ANNOUNCE_TIME`), so there is notice to RSVP, and the *event is created* `OP_PREP_LEAD_DAYS` earlier at the same local time (default **Tuesday 18:00**), so the mission makers have a day to replace its "Mission: TBD / Location: TBD" before the guild is pinged. Guarded by `OP_EVENT_DRY_RUN` (default true, like `SYNC_DRY_RUN`): a dry pass logs what it would do and writes nothing.

Four side effects. Each is guarded by a database column **and** reconciled against Discord's own state, so a pass that crashed between a Discord write and the DB write that records it resumes rather than duplicates:
1. **The `operation` row** (`getOrCreateWeeklyOperation`, unique `date`): created for the coming Saturday with the three windows (`OP_ATTENDANCE_START/END`, `OP_EVENT_END`).
2. **The scheduled event** (guard: `operation.discord_event_id`): `POST /guilds/{id}/scheduled-events`, `entity_type=3` (EXTERNAL), `privacy_level=2` (GUILD_ONLY), `entity_metadata.location="7R Operations Server"`, ISO-8601 start/end (event end = 23:30), name `"20:00 CEST/CET - Saturday Operation"` (the abbreviation follows DST), and a random in-game image (`OP_ANNOUNCE_IMAGE_DIR`) as the **cover banner** via the `image` field (Discord "image data": a base64 data URI; PNG/JPG/GIF). Needs **`CREATE_EVENTS` (1<<44)**; `MANAGE_EVENTS` (1<<33) only edits/deletes and 403s on create. The image is decorative, so a 400 (too large / unsupported) drops it and the event is created without a cover. **Before creating, the pass lists the guild's events (`listGuildScheduledEvents`) and adopts one matching this op's title + start instant**, so a lost `discord_event_id` never spawns a second event. There is **no bot API to change an event's RSVP list**; a bot creating via REST is not expected to appear "Interested" (that auto-subscribe is a client behaviour), so nothing is done about it.
3. **The mission-maker ping** (guard: `operation.prepared_at`): `POST /channels/{OP_PREP_CHANNEL_ID}/messages` at the prep moment, mentioning `OP_PREP_MENTION_ROLE_ID` (the Mission maker role) with the event link and the announcement deadline as a Discord `<t:…:F>` timestamp, so every reader sees it in their own timezone. `allowed_mentions: {roles:[id]}` (by id, not `parse:["roles"]`, so only that role can be notified). **`OP_PREP_CHANNEL_ID` is the switch for the whole step**: unset, the lead collapses to 0 and the job creates + announces in one pass at the announce moment, as it did before. The ping is skipped (and `prepared_at` left null) if a catch-up pass finds the announce moment already past, so nobody is asked to beat a deadline that has gone.
4. **The @everyone announcement** (guard: `operation.announced_at`): `POST /channels/{OP_ANNOUNCE_CHANNEL_ID}/messages` (#arma_general) with `@everyone`, an optional random witty message (`OP_ANNOUNCE_TEXT_PATH`; messages are blank-line-separated in the file and may span multiple lines), and the event URL `https://discord.com/events/{guild}/{event}` (posting it unfurls the event card, cover banner and native Interested button included). `allowed_mentions: {parse:["everyone"]}` so the ping fires. **Before posting, the pass scans the channel's recent messages (`listChannelMessages`) for the event link**, so a crash after posting but before the DB write never re-pings the guild; this dedup is best-effort (a missing Read Message History permission just forfeits it). The bot needs Send Messages + Mention @everyone (+ Read Message History for the dedup) in the channel.

Both pings scan the target channel for the event link before posting (`listChannelMessages`), so a crash after posting but before the DB write never re-pings; the dedup is best-effort either way.

`deno task op:preview` prints the coming op, both moments, and the exact messages it would post, writing nothing. The event's native RSVP ("Interested") list is the unit's op-planning tool. **Phase 6 records it** during the op, into `operation_rsvp`, so turnout can be compared against it (ADR 0020); it still drives nothing. (An earlier version of this line said "we store nothing for it and build no UI for it", which was right while the list had one job.)

### Attendance sampling (`apps/worker/attendance.ts`)
A reconciler on a timer, like the weekly event job: what to do is recomputed from the clock and the database every tick, so restarts and missed ticks are ordinary rather than special.

**The window test is the loop's own, not `plan.withinWindow`.** That flag closes at `attendanceStart`, because Discord refuses to schedule an event whose start is past (`planWeeklyOp`), which makes it false for the whole of the op: exactly the stretch this loop cares about. The sampler tests `now >= attendanceStart && now < attendanceEnd`.

Outside the window the pass does one cheap thing: `UPDATE attendance_session SET left_at = operation.attendance_end` for every span still open on an op whose window has passed. That one statement closes everyone still in the channel at 23:00 **and** repairs a worker that was killed mid-op, so neither case needs its own code path and neither depends on this process having been alive at the moment it mattered.

Inside the window, per tick:
1. `getOrCreateWeeklyOperation` for the coming Saturday. Called here rather than waited for: the weekly job creates the same row (same pure plan, same unique `date`), but only when `OP_EVENT_DRY_RUN` is false, and attendance must not stop recording because an unrelated switch has not been flipped.
2. **Gap check.** If `last_sample_at` is more than `2 × ATTENDANCE_SAMPLE_SECONDS` old, the worker was away: close every open span at `last_sample_at` first. Without this, an open span is read as "present until the window end" and a worker that was down 20:30-21:30 credits everybody for the blind hour. Two intervals rather than one, so an ordinary redeploy keeps spans whole instead of fragmenting every member's evening on every release.
3. `listChannelClients(teamspeak, TS_OPERATIONS_CHANNEL_CID)`: one ServerQuery command, through the throttle. **`cid` is stringified, and that is load-bearing**: the library sends one plain `clientlist` and filters in JavaScript against `ClientEntry.cid`, which is a *string*. A number matches nothing and returns an empty channel on every sample, silently, forever.
4. Diff against the spans the database says are open (`applySample` in `@7r/domain`), then insert the arrivals, close the departures and carry any nickname change across. **State lives in the table, not in a module variable**: an op runs for three hours and a deploy in the middle of one must not lose it. This departs from the earlier sketch here ("keep an in-memory map", "persist at the window's end") for exactly that reason.
5. Stamp `last_sample_at`, after the writes, so it never claims more than has been recorded.
6. **Capture the Interested list** if `ATTENDANCE_RSVP_REFRESH_SECONDS` has elapsed (ADR 0020). Best-effort: a failure is logged and swallowed, because the RSVP list is the half of the feature that can be lost and the presence sample is the half that cannot.

Resolve `tsUid -> member` at insert; unmatched uids are guests (`memberId = null`). Guests **auto-backfill**: the moment that person links their TeamSpeak identity (§4), past `attendance_session` rows with the matching `ts_uid` are attributed to them, and `/link` now reports how many. Any leftover is claimed via `/attendance claim` (ADR 0009).

**Errors** use the sync loop's leaky bucket, not the weekly job's page-on-first-failure: a single failed sample costs 90 seconds of resolution, a run of them means the op is being recorded wrong. There is **no `ATTENDANCE_DRY_RUN`**, and that is a deliberate departure from the house pattern: this writes only our own tables from read-only calls, so a flag would guard nothing while adding the failure ADR 0007 warns about (shipped, never flipped, unnoticed for two years, which is how the legacy recorder died in July 2024). `deno task attendance:preview` is the pre-flight check instead: it names the channel `TS_OPERATIONS_CHANNEL_CID` actually points at, and prints how many clients are on the server against how many the filter kept.

### Credit
A member is credited for an op if `sum(min(leftAt, attendanceEnd) - max(joinedAt, attendanceStart))` across their sessions ≥ `ATTENDANCE_MIN_MINUTES` (60). Compute on read; no need to materialize. Because it is computed on read, `ATTENDANCE_MIN_MINUTES` is read by **`apps/web`**, not the worker, which is why it has its own tiny schema (`attendanceCreditSchema`) that `opsSchema` extends: loading the full ops config on the website would drag the worker-only, required `OP_ANNOUNCE_CHANNEL_ID` onto it.

### What attendance is for
**Attendance is a statistic and nothing else.** Nobody acts on it. It gates no promotion, triggers no removal, and feeds no process. It shows on a member's own profile and in an admin-gated unit-wide view (turnout over time, the per-op RSVP cross-tab, roster counts, the guest worklist). The roster shows **counts, never an Active/Inactive label**: where that line sits is arguable, nothing consumes the answer, and a flag is an invitation for something to start. No historical attendance is imported (MIGRATION.md); the counter starts at zero.

This reuses the legacy `record-operation-attendees` approach (sample the Operations channel + diff), at a finer cadence. No Arma-side anything.

---

## 8. Discord interactions endpoint (`apps/web`)

`POST /api/discord/interactions`:
1. Verify the `X-Signature-Ed25519` + `X-Signature-Timestamp` headers against `DISCORD_PUBLIC_KEY` using WebCrypto (`crypto.subtle.verify('Ed25519', …)`) over `timestamp + rawBody`. Native on Deno: no flags, no polyfill.
2. **Read the RAW body bytes before parsing.** Verify over those exact bytes. Never `JSON.parse` and re-stringify; the re-serialisation will not be byte-identical and verification will fail (or, worse, you will be tempted to loosen it).
3. **Verification must FAIL CLOSED: return 401 on *any* exception, never 200.** Wrap the whole verify step so a malformed header, a bad base64 decode, or a thrown `subtle.verify` all end as 401. Discord deliberately sends invalid signatures to test the endpoint and will **remove your interactions URL** if you ever answer one with 200. That is a silent, delayed bot death: nothing errors, the bot just stops receiving commands.
4. Respond to `type:1` (PING) with `type:1` (PONG).
5. Dispatch `type:2` (APPLICATION_COMMAND), `type:3` (MESSAGE_COMPONENT: the `/link` select and button) and `type:5` (MODAL_SUBMIT: the `/link` code entry) to handlers; reply ephemerally where sensible (`flags: 64`). Route components/modals on a namespaced `custom_id` (e.g. `link:pick`, `link:enter`, `link:code`). **Respond within 3 seconds** or ack deferred and follow up via REST (`PATCH /webhooks/{app_id}/{token}/messages/@original`): response `type:5` (deferred reply) for commands **and the modal submit**, `type:6` (deferred update) for components, `type:7` updates the component's message in place, and `type:9` opens a modal. Types 6 and 7 are documented "only valid for component-based interactions", so the modal submit uses `type:5` and edits `@original` rather than an update. This matters on a cold container start, so prefer deferring anything that touches TeamSpeak or the guild member list — **except a modal: `type:9` must be the immediate response and cannot be deferred**, so a modal-opening handler must do no slow work (the `/link` button handler does none; the poke happens in the select handler before it).
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

Public content comes next, as the MVP, now that the identity layer (Phases 1-2) is built: the homepage, handbook and briefing generator are what the current website serves, so shipping them lets the domain cut over to the new stack, and everything built afterwards lands on the real website instead of a shadow deployment. TeamSpeak sync — the actual recurring pain, and the phase that pays for the project — follows immediately after the cutover (see ARCHITECTURE §9 for the reordering rationale).

0. **Prep (no code).** Stand `7R_Bot` up as the platform's Discord application: collect its app id, client secret, bot token and public key into `.env`; enable the GUILD_MEMBERS intent; move its role above every Assignable role; dial its Administrator grant back to `CREATE_EVENTS` + `MANAGE_ROLES`; clear any surviving `/loa`. The 2019 bot's account is not reused (ARCHITECTURE §7, ADR 0015). Harvest the 25 meme images: call `POST /api/v9/attachments/refresh-urls` with a token that can read the messages those attachments live in (`7R_Bot` should qualify; if not, borrow the legacy token locally, once) to get freshly-signed URLs, download, commit to the repo, serve from our own domain (the CDN links hardcoded in the old `fun.py` 404 for anonymous clients). **Create the 8 badge roles in Discord and backfill the 83 legacy grants** (32 members; every legacy user has a Discord id, so it is scriptable), without which badges cannot be Discord-authoritative; this writes Discord roles, so it comes after the bot is set up. Confirm the guild and the GHCR namespace, which do not change.
1. **Foundation. Built.** Monorepo skeleton (Deno workspaces), `config`, `domain`, `db` (Drizzle schema + first migration), Compose with Postgres, CI to GHCR.
2. **Identity (minimal web app). Built.** Discord login (Better Auth), member profile, TeamSpeak linking (pick-from-list + poked code), Steam OpenID linking. No public content yet. **Import the legacy links here** (MIGRATION.md). Note what this drags forward: the poke-link flow needs a **live ServerQuery connection**, so the TeamSpeak *transport* (`packages/teamspeak`, and the worker's `/internal/ts/*` API) lands in Phase 2, not Phase 4. Phase 4 then adds only the reconcile, on a connection that has already been exercised in production. The login is also gated on **guild membership**: a Discord account that is not in the guild gets told so, and no `member` row is written for it.
3. **Public content (the MVP).** Public site, branding, handbook (Starlight, no versioning; migrate the 21 `.md` files, move the 103 images to `public/wiki/images/` or rewrite the 96 absolute paths, strip the inline `float:right;width:500px` styles, restore the dropped sections), the stateless briefing generator (SQF byte-for-byte). Ends with the cutover: the domain switches to the new stack, replacing the current public site. None of this needs Phase 0 or a Discord application; only logging in to the member area does.
4. **TeamSpeak sync.** ServerQuery worker, seed the `assignable` mapping from git config (sgids resolved live, by name), Discord to TS reconcile with `deno task sync:preview` first, then the blast-radius guard. **This is the phase that pays for the project.**
5. **Discord bot.** Interactions endpoint (commands, components, modals), slash memes, role inspection, `/role` and `/rank set`, `/link` and `/unlink` (which replace the Phase 2 web link pages, removed here: ADR 0017), `/link-force`, the weekly scheduled-event job (which creates Operations).
6. **Attendance.** Operations-channel sampling, session reconstruction, read-only member and admin views, guest auto-backfill on link, `/attendance claim`, and the event RSVP captured and compared against turnout (ADR 0020). No historical import. `TS_OPERATIONS_CHANNEL_CID` becomes **required**, so it must be in the GitHub `production` Environment before this deploys or `env:check` stops the release.

There is no hardening phase. Backups are cut (ADR/ARCHITECTURE: the only irreplaceable data is ~100 TeamSpeak links) and infrastructure is out of scope (the deliverable is a `compose.yaml`). Log rotation and error-to-Discord alerts fold into the phases that need them.

---

## 11. Testing

**There is no live test environment.** No test Discord guild, no dockerised TeamSpeak server.

What is tested: **pure unit tests over the pure functions, plus whatever else can be reached without a socket.**
1. The three-way group reconcile (§6): given a member's Discord roles, the `assignable` mapping, and their current TS groups, produce `toAdd` / `toRemove`. Cover the leaver (no roles at all, so everything owned is removed), the unmapped role, the manual TS group outside `owned` (must be untouched), the >1 rank case, and the blast-radius trip.
2. The sample-to-session reconstruction (§7): given an ordered list of channel samples, produce `attendance_session` spans. Cover join, leave, rejoin, present-throughout, a mid-op rename, one identity connected twice (one person, one span, or their minutes double), and the close-at-`attendanceEnd` case. The rollups over those spans are pure too and are tested beside them: the per-op summary, the RSVP cross-tab (including the two matches that are structurally impossible, ADR 0020), and the per-member totals.

Three more things turned out to be reachable without a socket and are covered:
- **The Discord RSVP pagination** (`listGuildScheduledEventUsers`), against a stubbed `fetch`. Worth it because the failure is silent and the data unrecoverable: Discord cannot be asked after the op, so a bug that drops page two is a permanently short list rather than an error.
- **The command-option readers** (`subcommandOf`, `optionValue`), against real-shaped payloads. Including that a user option's snowflake survives as a string: round-trip it through a Number and `/attendance claim` credits the wrong person.
- **Two SQL statements, rendered rather than run.** `toSQL()` is pure and a `postgres.js` client dials nothing until a query runs, so the `UPDATE ... FROM` that closes dangling spans and the RSVP upsert's conflict target are checked in `packages/db/queries_test.ts`. Both fail in ways Postgres only raises at runtime, on the second refresh of the first real op.

Both take plain data in and return plain data out. Keep them that way: the I/O (ServerQuery calls, Discord REST) lives outside them, or this section stops being true.

**The I/O layer is exercised for the first time in production.** That is a deliberate trade-off: standing up a throwaway guild and a TS container is real, ongoing work for one developer in spare time, and would still not test the real server's group ids. The cost is real and worth naming: the first production run *is* the integration test, so a bug in the Discord poll, the ServerQuery calls, or the sgid mapping will be discovered live. That risk is bought down by two things and only two things: `SYNC_DRY_RUN=true` for the first passes (print, apply nothing), and the permanent blast-radius guard (§6) that halts any pass which would remove groups from more than `SYNC_MAX_REMOVALS` members. Neither is optional.

---

## 12. Deno / npm interop gotchas

Learned by running them. Ignoring any one of these costs a day.

**Pin Deno exactly; commit `deno.lock`.** `ts3-nodejs-library` pulls `ssh2`, which uses `node:crypto` for `aes128-gcm@openssh.com`, and a real TeamSpeak server negotiates exactly that cipher. Deno broke that code path three times and only repaired it in February 2026 (denoland/deno#32290). A floating Deno version is a live grenade under the one component that matters.

**Never run `deno approve-scripts` / `--allow-scripts`.** `cpu-features` (a transitive optional dep of `ssh2`) has an install script needing python + node-gyp. The yellow "ignored build scripts" warning is **correct behaviour**, not a problem to fix: the library runs pure-JS with zero native addons and only `--allow-net`.

**Every shared package that `apps/web` consumes needs a `package.json` alongside its `deno.json`.** Astro's bundler cannot resolve a `deno.json`-only workspace member: `Rolldown failed to resolve import "@7r/db"`. The npm/Deno split is *not* contained to `apps/web` (ADR 0006 said it was; it was wrong). Without the dual manifests, the monorepo's only stated benefit, a shared `domain`/`db` layer consumed by both web and worker, does not materialise for the website.

**Build Astro with Deno** (`deno run -A npm:astro build`) and add `RUN deno cache dist/server/entry.mjs` at image-build time, or a cold boot pulls 119 files from jsr.io and a jsr outage kills the container. See §1.

**A layout's `<style>` does not reach the pages that use it.** Astro scopes a component's CSS to that component's own elements, rewriting `.panel` to `.panel:where(.astro-hkbrpulz)` and stamping the hash onto the elements in that file. Page content arrives through `<slot />` carrying the *page's* hash, so every class the layout defines for it matches nothing. The member area shipped like this from Phase 2: `.panel`, `.row`, `button` and `.notice` were dead the whole time, and only the shell (`body`, `header`, `main`) looked right, which is exactly why nobody spotted it. Fixed by `<style is:global>` in `Base.astro`. Its CSS only ships with pages using that layout, so "global" means the member area and nothing else; the public site has its own stylesheets.

**No Astro session driver.** A full Discord login runs on Deno + Postgres with none configured. Better Auth owns its session table and signed cookie. (You cannot remove the `unstorage` package, Astro hard-depends on it; what you remove is the *config*.)

**Drizzle stays on 0.45.x, pinned.** 1.0 is still RC and will land mid-project. Two guardrails make the eventual upgrade a non-event: do **not** adopt the relational query builder (`.query` / `relations()`), and do **not** use the global `casing` option. The design uses only the core `pgTable` builder, so two of the three v1 breaking changes will not apply and the upgrade shrinks to the migrations-folder restructure.

**drizzle-kit on Deno needs two independent things:** `"nodeModulesDir": "auto"` in `deno.json` **and** `drizzle-kit` declared in `deno.json` `imports`. Having one without the other does not work.

**Apply migrations with the runtime migrator** (`drizzle-orm/postgres-js/migrator`), never `drizzle-kit migrate`, which drags `tsx` and three copies of esbuild into the image. drizzle-kit is a dev-time generator only.
