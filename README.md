# 7R Platform

The software platform for the **7th Ranger Group ("7R")**, an Arma 3 milsim unit
(~100 members, EU). It provides:

- the **public website**: info, handbook, and the mission briefing generator;
- a **Discord bot**: memes, role inspection, admin commands, and the weekly job
  that creates the Saturday op;
- **one-way Discord -> TeamSpeak role sync**, which removes the hand-management
  of TeamSpeak server-groups (the toil this project actually exists to kill);
- **op attendance**, recorded from presence in the TeamSpeak Operations channel.

Built and run by one developer in spare time. The unit's low complexity budget
is the governing constraint: when in doubt, cut.

## Shape

A **Node 26 monorepo** on pnpm workspaces. No meta build tool (no Nx, no
Turbo). Node runs the TypeScript directly, so there is no build step for the
packages or the worker (ADR 0021).

- `apps/web`: Astro SSR on Node. Serves the public site, the member area, and
  the **Discord interactions endpoint** (the bot is just a route).
- `apps/worker`: a long-running Node process. Holds the TeamSpeak ServerQuery
  connection (SSH transport) and runs the scheduled jobs: role reconcile,
  attendance sampling, the weekly event.
- `packages/*`: shared `config`, `domain`, `logging`, `db` (Drizzle), `discord`,
  `teamspeak`, `identity`.
- **Postgres** is the shared state. Everything ships as one `compose.yaml`.

## Load-bearing ideas

- **Discord is the identity hub** and the only login (ADR 0001).
- **Discord roles are the source of truth.** TeamSpeak is synced one-way from
  them, and the sync only ever touches groups it owns (ADR 0002).
- **The bot is HTTP-only.** No gateway, no always-on stateful Discord process
  (ADR 0003).
- **Attendance is TeamSpeak Operations-channel presence** (ADR 0007), and it is
  **a statistic nobody acts on**: it gates no promotion and triggers no removal
  (ADR 0010).
- **There is no admin web UI.** The Assignable mapping is git-tracked config
  applied by a seed task, the sync dry-run is a CLI task, and admin actions are
  admin-gated slash commands (ADR 0009).

## Documentation

| File                     | What it is                                                                                                                                 |
| :----------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT.md`             | The glossary and the ubiquitous language: Member, Assignable (Rank / Role / Badge), Operation, Attendance session, Guest. Read this first. |
| `docs/ARCHITECTURE.md`   | The plan and the spec. There is no separate requirements document.                                                                         |
| `docs/IMPLEMENTATION.md` | The mechanics: how each subsystem actually works.                                                                                          |
| `docs/MIGRATION.md`      | The legacy import: what comes across from the old DB, and what deliberately does not.                                                      |
| `docs/adr/`              | The decisions, with their reasons.                                                                                                         |
| `docs/OPEN-QUESTIONS.md` | The resolved-question log.                                                                                                                 |

## Status

**Phases 1 (Foundation) and 2 (Identity) are built.** The workspace, `config`,
`domain`, `db`, the Compose stack and CI to GHCR came first. On top of them:
Discord login (Better Auth), the member profile, TeamSpeak linking (pick
yourself from the online list, the bot pokes you a code, you type it back),
Steam OpenID linking, and the legacy import (150 members, 99 TeamSpeak links,
23 Steam ids).

**Phase 2 cannot actually be used until Phase 0 is done**, and Phase 0 is still
outstanding. It is prep work with no code: set the `7R_Bot` Discord application
up as the platform's bot (its four credentials into `.env`, the GUILD_MEMBERS
intent enabled, its role moved above every Assignable role, its Administrator
grant dialled back), register `<PUBLIC_BASE_URL>/api/auth/callback/discord` as
its OAuth redirect, harvest the meme images, and create the 8 badge roles in
Discord. Nobody can log in until the first of those is done, because the login
gate asks Discord whether you are in the guild.

**The plan was re-cut on 2026-07-15: public content is next, as the MVP.**
The homepage, the handbook and the briefing generator (Phase 3) are what the
current website serves, so once they exist the domain switches over to the new
stack — and everything built afterwards lands on the real website instead of a
shadow deployment. The cutover does not wait on Phase 0: the public pages are
static content and need no Discord application (only logging in does). Then
come the TeamSpeak group sync (Phase 4, the one that pays for the project),
the bot's slash commands (5) and attendance (6). See `ARCHITECTURE.md` §9.

## Development

`pnpm` scripts are the interface (root `package.json`). See `AGENTS.md`.

```sh
pnpm install
pnpm check && pnpm test                # typecheck + unit tests
pnpm web:dev                           # Astro dev server

docker compose up -d postgres
docker compose --profile migrate run --rm migrate
docker compose up -d                   # web + worker + postgres
```

- **Commit `pnpm-lock.yaml` and pin the Node and pnpm versions exactly.** Node is
  in `.node-version`, pnpm in the root `package.json` (`packageManager`), and
  both are repeated in the Dockerfiles; CI fails if they disagree. The repo runs
  `.ts` through Node's native type stripping, and what that accepts has changed
  between releases.
- **Never approve a dependency build script.** `allowBuilds` in
  `pnpm-workspace.yaml` denies `cpu-features` (an optional native addon pulled in
  by `ssh2` that we do not want), and an install fails on any build script nobody
  has reviewed. Do not run `pnpm approve-builds`.
