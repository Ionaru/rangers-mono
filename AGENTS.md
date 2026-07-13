# Working in this repo

A Deno 2 monorepo on native workspaces. `deno task` is the interface; there is
no npm script layer. Deno lives at `~/.deno/bin` and may not be on `PATH` in a
non-interactive shell.

Read `CONTEXT.md` first: it is the glossary, and the names in it (Member,
Assignable, Operation, Attendance session, Guest) are the ones the code uses.
`docs/ARCHITECTURE.md` is the spec and the phase plan, `docs/IMPLEMENTATION.md`
is the mechanics, and `docs/adr/` is why. If this file contradicts an ADR, the
ADR wins.

## Layout

```
packages/config    env parsing (zod), fails loud at boot, lazy
packages/domain    types and pure rules. Zero I/O. Keep it that way
packages/db        Drizzle schema, queries, migrations
apps/web           Astro 7 SSR on Deno. Also serves the Discord interactions endpoint
apps/worker        long-running Deno process: TeamSpeak, scheduled jobs
```

Shared packages carry **both** a `deno.json` and a `package.json`. That is not
bookkeeping: Astro's bundler cannot resolve a `deno.json`-only workspace member
(ADR 0006). `apps/web` is `package.json`-only.

## Tasks

```
deno task check        typecheck        deno task test         unit tests
deno task lint         lint             deno task fmt          format
deno task web:dev      Astro dev        deno task web:build    build with Deno
deno task worker:dev   worker (watch)
deno task db:generate  generate a migration from schema.ts
deno task migrate      apply migrations (one-shot, never on boot)
```

The stack: `docker compose up -d postgres`, then
`docker compose --profile migrate run --rm migrate`, then
`docker compose up -d`. Local development needs `secrets/` populated (see
`secrets/README.md`) and a `.env` (copy `.env.example`).

## Rules that cost a day when broken

- **Build Astro with Deno**, always: `deno run -A npm:astro build`. An artifact
  built with `npx astro build` dies at boot on Deno unless ~276 MB of
  `node_modules` ships into the image.
- **Never run `deno approve-scripts` / `--allow-scripts`.** The "ignored build
  scripts" warning is correct behaviour; the script (`cpu-features`, pulled in
  by `ssh2`) is an optional native addon we do not want.
- **Pin the Deno version.** It lives in `.dvmrc`, both Dockerfiles, and
  `.github/workflows/cd.yaml`, and CI fails if they disagree. It is load-bearing
  twice over: `ssh2` leans on `node:crypto` for a cipher Deno has broken before,
  and the workspace symlinking this whole layout depends on only landed in Deno
  2.9.
- **Drizzle is on 1.0 (`1.0.0-rc.4`, an RC on purpose: ADR 0016).** Still no
  `relations()` / `.query` and no global `casing` (ADR 0008; 1.0 removed the
  first outright). `drizzle({ client: sql })`, never `drizzle(sql)`: 1.0 dropped
  the bare-client overload and silently opens a connection from `PGHOST` instead.
  Migrations are one folder each (`<timestamp>_<name>/migration.sql`); there is
  no `meta/_journal.json` any more. Regenerate after any `schema.ts` change; CI
  fails if the committed SQL has drifted.
- **`packages/domain` does no I/O.** The two functions the test suite exists for
  (the group reconcile, the sample-to-session reconstruction) are only testable
  without a live server because they take plain data in and return plain data
  out.
- **Config is lazy.** Never parse the environment at module scope: `astro build`
  executes module code, so a top-level parse turns a missing production secret
  into a failed build.

## Testing

There is no live test environment: no test Discord guild, no dockerised
TeamSpeak. Testing is pure unit tests over pure functions, and the I/O layer is
first exercised in production behind `SYNC_DRY_RUN` and the blast-radius guard.
That is a deliberate, documented trade-off (ARCHITECTURE §9), not an oversight
to be fixed by mocking TeamSpeak.

## Astro

Docs: https://docs.astro.build

- [Routing, dynamic routes, middleware](https://docs.astro.build/en/guides/routing/)
- [Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Framework components](https://docs.astro.build/en/guides/framework-components/)
- [Content collections](https://docs.astro.build/en/guides/content-collections/)
- [Styling](https://docs.astro.build/en/guides/styling/)
