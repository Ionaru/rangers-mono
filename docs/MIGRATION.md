# Legacy import (rangers-site MySQL -> new Postgres)

Source: `Dump20260711.sql` (the abandoned rangers-site MySQL DB). ~150 members, 228 TeamSpeak identities, 433 operations, ~83k attendance samples, plus the rank/role/badge mappings. Import is a one-shot script run in **Phase 3** (identities/mappings) and **Phase 6** (historical attendance).

Because Discord is now the source of truth for roles (ADR 0002), we import **identity links**, **assignable definitions**, and **history**, but **not** per-member role/rank/badge assignments (a member's current Discord roles are the truth).

---

## Two gotchas, read first

1. **Stale TeamSpeak sgids.** The legacy `teamspeakRank` table has duplicate group names with different ids (e.g. `Arma3 Member` is both `65` and `14297`; `Arma3 NCO` `66`/`14354`; `Arma3 Recruit` `68`/`26336`; `Arma3 Officer` `71`/`27548`; `Arma3 Reserve` `79`/`27767`). The TS server was rebuilt at some point, so the sgids stored on `rank`/`role`/`badge` may be dead. **Resolve every sgid by group NAME against a live `servergrouplist`**, do not trust the stored number. Log any name that has no live match.
2. **Badges have no Discord role.** All 8 `badge` rows have `discordRole = NULL`. For Discord-as-source-of-truth to drive badges, each badge needs a Discord role created and mapped first. Until then, badges can be imported as `assignable` rows only if you relax the `discord_role_id NOT NULL` constraint or (preferred) **create the Discord roles for badges and fill them in** before importing. Treat this as a required manual step with the unit.

Also: `steamUser` was never populated (nothing to import for Steam); members link Steam fresh via OpenID.

---

## Assignable seed (from the dump)

`kind`, `name`, `discordRoleId` (Discord snowflake), `legacyTsRankId` (resolve to a live sgid by name):

**Ranks** (kind=`rank`, mutually exclusive):

| name | discordRoleId | legacy sgid | TS group name |
|---|---|---|---|
| Officer | 308218743085989888 | 71 | Arma3 Officer |
| NCO | 308219154396217344 | 66 | Arma3 NCO |
| Member | 308221089681637376 | 65 | Arma3 Member |
| Recruit | 440484951507599370 | 68 | Arma3 Recruit |
| Reserve | 657877767186022412 | 79 | Arma3 Reserve |

**Roles** (kind=`role`, additive):

| name | discordRoleId | legacy sgid | TS group name |
|---|---|---|---|
| Recruiter | 432647112275001358 | 64 | Recruiter |
| Instructor | 455066329532203008 | 72 | Instructor |
| Mission maker | 432647098517684246 | (none) | (no TS group) |

**Badges** (kind=`badge`, additive, **discordRoleId MISSING — create + fill**):

| name | discordRoleId | legacy sgid | TS group name |
|---|---|---|---|
| Leadership | TODO | 73 | Leadership |
| Armoured | TODO | 78 | Armoured |
| Marksman | TODO | 77 | Marksman |
| Medic | TODO | 76 | Medic |
| Heavy Weapons | TODO | 74 | Heavy Weapons |
| Fixed-Wing Aviation | TODO | 70 | Fixed-Wing Aviation |
| Rotary Aviation | TODO | 69 | Rotary Aviation |
| Engineer | TODO | 75 | Engineer |

The `Rotary Aviation` (69) and `Fixed-Wing Aviation` (70) TS groups also exist as legacy ranks-list entries; they are badges here. Resolve all by name against the live server.

---

## Table-by-table mapping

| Legacy table | New target | Notes |
|---|---|---|
| `user` (150) | `member` | Only rows with non-null `discordUser` become members (discord_id is required). `discordUser`->`discordId`, `name`->`displayName`, `disabled`->`disabledAt`. Join `ts3UserId`->`teamspeakUser` for `tsUid`/`tsNickname`; set `tsLinkMethod='legacy_import'`, `tsVerifiedAt=user.updatedOn`. `steamUser`->`steamId` (almost always null). Drop `uuid`, `rankId` (roles come from Discord). |
| `teamspeakUser` (228) | (join source) + guest identities | Used for member `tsUid` and as the attendee reference for historical attendance. Identities not linked to any member remain guests in imported attendance. |
| `rank` / `role` / `badge` | `assignable` | See the seed above. Resolve `teamspeakRankId`->live sgid by name. Badges need Discord roles first. |
| `teamspeakRank` | (lookup only) | Name lookup for sgid resolution; do not import (it's stale/duplicated). |
| `operation` (433) | `operation` | `createdOn`->`date` and `attendanceStart` (Sat 20:00). Set `attendanceEnd=+3h` (23:00), `eventEnd=+3.5h`, `source='auto_weekly'`, `discordEventId=null`. |
| `attendance` (83k) | `attendance_session` | Per (operation, attendee), sort samples by `time` and coalesce consecutive samples (gap <= ~16min) into sessions: `joinedAt=first`, `leftAt=last + one sample interval`. Resolve attendee `teamspeakUser.uid`->`member.tsUid`; unmatched -> guest (`memberId=null`, keep `tsUid`/`tsNickname`). Coarser (15-min) than new sessions, which is fine for history. |
| `loa` (2806) | `loa` | `date`->`date`. `user` is a legacy string; best-effort resolve to a `member` (by discord id or name); rows that don't resolve are logged and skipped. |
| `permission`, `rank_permissions_permission`, `role_permissions_permission` | (skip) | New authorization is Discord-admin-role based (`DISCORD_ADMIN_ROLE_IDS`), not a DB permission model. |
| `session` | (skip) | Old express sessions. |
| `application`, `enjinTag`, `incident`, `incident_users_user`, `migrations` | (skip) | Not carried. |

---

## Import order

1. Resolve sgids: pull a live `servergrouplist`, build `name -> current sgid`.
2. Seed `assignable` (ranks, roles; badges once their Discord roles exist).
3. Import `member` (discord-linked users only) with their TeamSpeak link.
4. Import `operation`, then reconstruct `attendance_session` from `attendance`.
5. Import `loa` (best-effort resolution).
6. Verify: run the role-sync **dry-run** and confirm the preview matches expectations before enabling live sync.

Keep the script idempotent (upsert by natural key: `member.discordId`, `assignable.discordRoleId`, `operation.date`) so it can be re-run after the Discord roles for badges are filled in.
