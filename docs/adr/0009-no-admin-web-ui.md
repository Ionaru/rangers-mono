# No admin web UI; platform admin via git-config, slash commands, and a CLI

The platform has **no admin web panel**. Role assignment stays in Discord and the bot's `/role` slash commands (ADR 0002). The remaining platform-only admin concerns are handled as:

- **git-tracked config** for the Assignable mapping (Discord role <-> TeamSpeak group, and the rank/role/badge kind), applied by a seed task;
- **admin-gated slash commands** for identity-link exceptions (`/link-force`) and the rare manual guest claim;
- a **CLI task** (`deno task sync:preview`) for the sync dry-run.

The website carries only **read-only** views (a member's own attendance, and a plain read-only roster).

## Why

ADR 0002 makes Discord the source of truth for roles, so there is no roster to *manage* inside the platform, only platform-only data that Discord cannot represent. Those concerns are low-churn (the mapping changes rarely), exception-based (force-link), or automatable: guest attendance sessions are auto-backfilled to a member the moment they link their TeamSpeak identity, so manual claiming is rare. Building and maintaining a web admin panel for that is disproportionate for a spare-time project, and it risks drifting back into a second roster. Config + commands + CLI is lighter and keeps the boundary sharp.

## Guardrail

Anything that changes a member's roles writes **through to Discord** (the single source of truth); the platform never stores its own authoritative role assignments. The `assignable` table is *derived* from the git config (applied by the seed task), not hand-edited as a source of record.

## Consequences

- Assignable mapping changes go through a PR + re-seed (a deploy), not a live editor. Fine for ~16 rarely-changing rows.
- Admin actions (`/link-force`, `/attendance claim`) live in the bot's slash-command surface, gated by `DISCORD_ADMIN_ROLE_IDS`.
- The sync dry-run is `deno task sync:preview` (prints the add/remove diff); the live sync runs headless.
- Guest attendance auto-resolves when a member links their TeamSpeak identity (backfill past sessions by `ts_uid`); a leftover is claimed via an admin command.
- Read-only roster/attendance views are ordinary site pages, not an admin panel.
- Revisit only if admins find config-by-PR too slow, or the diffs too hard to read in a terminal.
