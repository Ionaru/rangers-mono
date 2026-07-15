# Legacy import (rangers-site MySQL -> new Postgres)

Source: `data/Dump20260711.sql` (the abandoned rangers-site MySQL DB). Real row counts, parsed from the dump (the old numbers in this doc were AUTO_INCREMENT values, not row counts):

| Table | Rows |
|---|---|
| `user` | 150 (all 150 have a `discordUser`; 99 have a `ts3UserId`; 23 have a `steamUser`; 76 have a rank; `disabled` is 0 on every row) |
| `teamspeakUser` | 228 |
| `operation` | 401 |
| `attendance` | 75,241 |
| `loa` | 2,667 |
| `rank` / `role` / `badge` | 5 / 3 / 8 |
| `user_badges_badge` | 83 grants across 32 distinct members |
| `user_roles_role` | 21 |
| `permission` | 7 |
| `application`, `incident`, `incident_users_user` | 0 (stub tables, never built) |

The import is a one-shot script. The identity links land in **Phase 2** (identity), the Assignable mapping seed lands in **Phase 4** (TeamSpeak sync). There is no attendance import phase: attendance starts from zero.

Because Discord is the source of truth for roles (ADR 0002), we import **identity links** and **assignable definitions** only. We do **not** import per-member role/rank/badge assignments (a member's current Discord roles are the truth), and we do **not** import history (attendance, operations, LOA).

---

## Two gotchas, read first

1. **Stale TeamSpeak sgids.** The legacy `teamspeakRank` table has duplicate group names with different ids (e.g. `Arma3 Member` is both `65` and `14297`; `Arma3 NCO` `66`/`14354`; `Arma3 Recruit` `68`/`26336`; `Arma3 Officer` `71`/`27548`; `Arma3 Reserve` `79`/`27767`). The TS server was rebuilt at some point, so the sgids stored on `rank`/`role`/`badge` may be dead. **Resolve every sgid by group NAME against a live `servergrouplist`**, do not trust the stored number. The seed task **prints the proposed name-to-sgid mapping to the terminal and waits for confirmation before any write**, and logs any name with no live match. There is no admin web UI (ADR 0009), so the terminal is where you confirm.
2. **Badges have no Discord role, and that is a Phase 0 task. But the grants come from TeamSpeak, NOT from this dump.** All 8 `badge` rows have `discordRole = NULL`: badges only ever existed as TeamSpeak groups. ADR 0002 makes Discord authoritative for every Assignable, so badges cannot work until they exist in Discord.

   **The 83 grants in `user_badges_badge` are STALE and must not be used.** An earlier version of this document said to backfill them, and it was wrong in a way that would have been invisible: the legacy table is years out of date, and the *current* record of who has earned which badge is the **live TeamSpeak server groups**. Badges are the one Assignable that never existed as a Discord role, so TeamSpeak is the only place the truth was ever kept.

   So Phase 0 runs the arrow backwards, exactly once: **TeamSpeak -> Discord**. `deno task badges:backfill` reads the live badge groups by name, resolves each holder's TeamSpeak uid to a Member through the identity links imported above, creates the 8 Discord roles, and grants them. Dry-run by default; `--apply` to write. It prints the new role ids in the shape the badge table below wants. After it, Discord is authoritative for badges like everything else and the sync only ever writes TeamSpeak.

   New roles are created at the **bottom** of the Discord role list, which is what puts them below `7R_Bot` and therefore assignable at all (hierarchy is not bypassed by any permission).

   **Watch the unmapped.** A TeamSpeak identity holding a badge that resolves to no Member cannot be given a Discord role. It is **not** stripped by the reconcile, which only iterates members that have a linked `ts_uid` and so never touches an identity that is nobody's `ts_uid`. The trap is later and conditional: a real member here who *links this exact identity* while Discord lacks the badge **loses it by linking**, because the reconcile then sees a TeamSpeak group with no Discord counterpart. So reconcile this list by hand before the sync leaves dry-run: grant the Discord role to the real people, or have them link and re-run the backfill (idempotent). People who have left the unit never link, so their badge lingers harmlessly on a dead identity.

---

## Steam

`steamUser` **is** populated: **23** of the 150 users have a SteamID64. (An earlier version of this doc claimed it was empty. That was wrong.)

Steam is a plain profile field: it proves account ownership via Steam OpenID and gives members a SteamID64 to find each other with. It gates nothing and it is optional. So seeding the 23 is **optional**: copy them across if you want the profiles pre-filled, otherwise members re-link in seconds via OpenID. Nothing downstream depends on it either way.

---

## Assignable seed (from the dump)

`kind`, `name`, `discordRoleId` (Discord snowflake), `legacyTsRankId` (resolve to a live sgid by name).

**Ranks** (kind=`rank`, exclusive: a member has exactly one). Five of them. `Reserve` is a real rank, meaning "still one of us, not currently active"; it is not a rung on the ladder and sorts last.

| name | discordRoleId | legacy sgid | TS group name |
|---|---|---|---|
| Officer | 308218743085989888 | 71 | Arma3 Officer |
| NCO | 308219154396217344 | 66 | Arma3 NCO |
| Member | 308221089681637376 | 65 | Arma3 Member |
| Recruit | 440484951507599370 | 68 | Arma3 Recruit |
| Reserve | 657877767186022412 | 79 | Arma3 Reserve |

**Roles** (kind=`role`, additive). A Role is a **staff function** a member is appointed to, not a qualification. In the legacy these carried the admin permissions.

| name | discordRoleId | legacy sgid | TS group name |
|---|---|---|---|
| Recruiter | 432647112275001358 | 64 | Recruiter |
| Instructor | 455066329532203008 | 72 | Instructor |
| Mission maker | 432647098517684246 | (none) | (no TS group) |

**Badges** (kind=`badge`, additive, **discordRoleId MISSING, create in Phase 0 and fill in**). A Badge is a **training qualification** a member earned. Medic and the two aviation badges are qualifications, not staff roles.

Discord role ids created by `deno task badges:backfill` on 2026-07-15 (the role is named with a 🎖️ prefix in Discord; the canonical name here and on TeamSpeak stays plain).

| name | discordRoleId | legacy sgid | TS group name |
|---|---|---|---|
| Leadership | 1526736084996718796 | 73 | Leadership |
| Armoured | 1526736083172462633 | 78 | Armoured |
| Marksman | 1526736080987226162 | 77 | Marksman |
| Medic | 1526736079737192549 | 76 | Medic |
| Heavy Weapons | 1526736084267175977 | 74 | Heavy Weapons |
| Fixed-Wing Aviation | 1526736093804757024 | 70 | Fixed-Wing Aviation |
| Rotary Aviation | 1526736092861300936 | 69 | Rotary Aviation |
| Engineer | 1526736082207641680 | 75 | Engineer |

The `Rotary Aviation` (69) and `Fixed-Wing Aviation` (70) TS groups also appear in the legacy ranks list; they are badges here. Resolve all of them by name against the live server.

---

## Table-by-table mapping

| Legacy table | New target | Notes |
|---|---|---|
| `user` (150) | `member` | All 150 have a `discordUser`, so all 150 qualify. `discordUser`->`discordId`, `name`->`displayName`. Join `ts3UserId`->`teamspeakUser` for `tsUid`/`tsNickname` (99 users have one); set `tsLinkMethod='legacy_import'` and flag those links for re-verification. `steamUser`->`steamId` optional (see Steam above). **Do not map `disabled`**: it is 0 on every row, so the column was never used and means nothing. Drop `uuid` and `rankId` (rank comes from Discord). |
| `teamspeakUser` (228) | (join source) | Only used to resolve `tsUid`/`tsNickname` for the 99 linked members. Not imported as rows of its own: without an attendance import there is nothing for an unlinked TS identity to hang off. |
| `rank` / `role` / `badge` | `assignable` | See the seed above. Resolve `teamspeakRankId` -> live sgid by name (gotcha 1). Badge Discord roles must exist first (gotcha 2). |
| `teamspeakRank` | (lookup only) | Name lookup for sgid resolution. Never import its numbers: they are stale and duplicated. |
| `user_badges_badge` (83), `user_roles_role` (21) | **not imported, and not used at all** | Discord is the truth for assignments. `user_badges_badge` was going to be the input to the Phase 0 badge backfill; it is **years out of date** and must not be. The badge truth is the live TeamSpeak groups (gotcha 2). |
| `operation` (401) | **not imported** | The legacy `operation` table has **no date column at all**, so the rows cannot even be placed in time. With no attendance to hang off them, there is nothing to import. |
| `attendance` (75,241) | **not imported** | Attendance starts from zero. Reasons: it is a statistic nobody acts on; the last write was **2024-07-27**, two years dead, and the unit did not notice; 113 of the 401 operations have zero samples; the `operation` table has no date column; 90 of the 188 TeamSpeak attendees link to no member; and the legacy 15-minute sample resolution does not match the new 90-second sampling, so mixing them would quietly mix two precisions in one number. |
| `loa` (2,667) | **not imported** | There is no `loa` table in the new schema. Planning who turns up for an op is Discord scheduled-event RSVP (the native "Interested" list on the event the weekly job already creates). |
| `permission`, `rank_permissions_permission`, `role_permissions_permission` | (skip) | Admin is a single boolean derived from `DISCORD_ADMIN_ROLE_IDS`. The legacy 7-permission model is deliberately not ported. |
| `session` | (skip) | Old express sessions. |
| `application`, `enjinTag`, `incident`, `incident_users_user`, `migrations` | (skip) | Not carried. `application` and `incident` are empty stubs anyway. |

---

## Import order

1. **Phase 0 (manual, no code):** stand `7R_Bot` up as the platform's Discord app first (credentials into `.env`, GUILD_MEMBERS intent, `MANAGE_ROLES`, its role above every role it will manage: ADR 0015). Then create the 8 badge roles in Discord *below* it, backfill the 83 grants to the 32 members who hold them, and fill the role ids into the badge table above.
2. **Phase 2:** import `member` (all 150) with their TeamSpeak link (99 of them), marked `tsLinkMethod='legacy_import'` and flagged for re-verification. Optionally seed the 23 Steam ids.
3. **Phase 4, step 1:** resolve sgids. Pull a live `servergrouplist`, build `name -> current sgid`, print the mapping to the terminal, confirm, log any name with no live match.
4. **Phase 4, step 2:** seed `assignable` (5 ranks, 3 roles, 8 badges) from the git-tracked config with the resolved sgids.
5. **Phase 4, step 3:** verify. Run `deno task sync:preview` (the dry-run) and confirm the preview matches expectations before enabling live sync. The blast-radius guard stays on afterwards.

Keep the script idempotent (upsert by natural key: `member.discordId`, `assignable.discordRoleId`) so it can be re-run after the badge Discord roles are filled in, or after a sgid mapping is corrected.
