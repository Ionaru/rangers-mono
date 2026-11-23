# Working in this repo

A Node 26 monorepo on pnpm 12 workspaces (ADR 0021). `pnpm <script>` is the
interface: the scripts live in the root `package.json`, and a few fan out to a
member's own. Node is pinned in `.node-version` and pnpm in the root
`package.json` (`packageManager`). Run `pnpm install` once before anything else.
Node runs the TypeScript directly (native type stripping): there is no build
step for the packages, the worker or the CLIs.

Read `CONTEXT.md` first: it is the glossary, and the names in it (Member,
Assignable, Operation, Attendance session, Guest) are the ones the code uses.
`docs/ARCHITECTURE.md` is the spec and the phase plan, `docs/IMPLEMENTATION.md`
is the mechanics, and `docs/adr/` is why. If this file contradicts an ADR, the
ADR wins.

## Layout

```
packages/config      env parsing (zod), fails loud at boot, lazy
packages/domain      types and pure rules. Zero I/O. Keep it that way
packages/logging     LogTape: getLogger everywhere, configureLogging at entry points
packages/db          Drizzle schema, queries, migrations
packages/discord     fetch-based REST helpers, Ed25519 verify, command definitions
packages/teamspeak   ServerQuery client (throttled), group reads and writes, channel sampling
packages/identity    linking rules and link codes
apps/web             Astro 7 SSR on Node. Also serves the Discord interactions endpoint
apps/worker          long-running Node process: TeamSpeak, scheduled jobs
```

Every member is a plain `package.json` package listed in `pnpm-workspace.yaml`.
The `packages/*` export their TypeScript source
(`./mod.ts`) and import each other as `@7r/*` through pnpm's `workspace:*`
links; there is no per-package build.

## Tasks

```
pnpm check          typecheck (tsc, then astro check)     pnpm test        unit tests (node:test)
pnpm lint           ESLint                                pnpm fmt         Prettier (fmt:check to verify)
pnpm web:dev        Astro dev                             pnpm web:build   build the Astro app
pnpm worker:dev     worker (watch)
pnpm db:generate    generate a migration from schema.ts
pnpm migrate        apply migrations (one-shot, never on boot)
pnpm env:check      check a .env against the config schemas (read-only)
pnpm attendance:preview   names the channel TS_OPERATIONS_CHANNEL_CID points at (read-only)
```

The other operator CLIs follow the same pattern (`pnpm import:legacy`,
`phase0:check`, `commands:register`, `ts:check`, `badges:backfill`,
`assignables:seed`, `sync:preview`, `op:preview`). pnpm passes arguments through
without a `--`: `pnpm commands:register --apply`. Markdown is not run through
Prettier (the docs are hand-wrapped prose).

The stack: `docker compose up -d postgres`, then
`docker compose --profile migrate run --rm migrate`, then
`docker compose up -d`. Local development needs `secrets/` populated (see
`secrets/README.md`) and a local `.env` (copy `.env.example`).

**Production config is not a hand-maintained `.env` (ADR 0018).** It lives in the
GitHub `production` Environment: non-secret values as variables, credentials as
secrets, each named as its `.env` key. The deploy (`.github/workflows/cd.yaml`)
assembles `.env` from them and writes it to the box, so **change a value** = edit the
one variable/secret, **add a key** = add one entry (no `cd.yaml` change), and never
hand-edit the box `.env`. `pnpm env:check` (also the deploy's gate) names any
missing-required key. The DB password/URL stay file-based in `./secrets/` (ADR 0014).

## Rules that cost a day when broken

- **Never approve a dependency build script.** `allowBuilds` in
  `pnpm-workspace.yaml` denies `cpu-features` (an optional native addon pulled in
  by `ssh2` that we do not want), `esbuild` and `ssh2`, and `strictDepBuilds`
  makes an install fail on any build script nobody has reviewed. Decide the new
  one in that file; never run `pnpm approve-builds` and never set
  `dangerouslyAllowAllBuilds`. The same file's `permissions` block denies the
  agent skills that `@logtape/logtape` and `drizzle-kit` offer to install.
- **Attendance has no dry-run, and it fails silently.** The sampler writes only
  our own tables, so there is deliberately no `ATTENDANCE_DRY_RUN` to forget to
  flip. The cost is that a wrong `TS_OPERATIONS_CHANNEL_CID` records every op as
  empty and never errors: `clientList`'s channel filter runs client-side and
  matches `cid` as a **string**, so a number (or a wrong id) simply returns
  nobody. Run `pnpm attendance:preview` before trusting it; it prints the
  channel's NAME and how many of the server's clients the filter kept. The
  legacy recorder died in July 2024 and went unnoticed for two years, which is
  the failure mode this is guarding against (ADR 0007).
- **A layout's `<style>` does not reach the pages that use it.** Astro scopes CSS
  to the component's own elements, so everything `Base.astro` defines for slotted
  page content (`.panel`, `.row`, `button`, tables) matched nothing until it was
  marked `is:global`. Only the shell looked right, which is why it shipped
  unnoticed from Phase 2. Keep the `is:global` on that block.
- **Mind the ServerQuery command budget.** TeamSpeak refuses a query client that
  sends more than 10 commands in 3 seconds, and the library's answer to being
  refused is to re-send the same command every second, forever: a burst does not
  fail, it quietly degrades to a crawl and holds the one connection the whole
  process shares. Anything new that talks to TeamSpeak should cost commands
  proportional to the number of *groups or channels*, not the number of members,
  and it must go through `packages/teamspeak` so the throttle in front of
  `execute` applies. Phase 4 shipped a reconcile at two commands per member and
  flooded for three and a half minutes out of every five.
- **Pin the Node and pnpm versions.** Node lives in `.node-version` and in every
  `FROM node:` of both Dockerfiles; pnpm in the root `package.json`
  (`packageManager`) and in both Dockerfiles' `npm install -g pnpm@...` (Node 25
  and later no longer bundle corepack). CI fails if any of them disagree. It is
  load-bearing because the repo runs `.ts` through native type stripping, and what
  that accepts has changed between Node releases.
- **Node will not type-strip a `.ts` file whose real path is under
  `node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). A workspace
  package reached through a pnpm symlink is fine, because its real path is
  `packages/<name>`; a copied one is not. So the worker image installs in place
  and keeps those symlinks, and is never built with `pnpm deploy`, which copies
  the packages into `node_modules`. The web bundle inlines `@7r/*`
  (`vite.ssr.noExternal` in `astro.config.mjs`) for the same reason.
- **Type-only imports must be `import type`.** Node strips types without
  analysing them, so `import { SomeType } from "./x.ts"` for a type that has no
  runtime value fails at runtime. `tsc` enforces it (`verbatimModuleSyntax`), as
  it does `erasableSyntaxOnly`: no enums, no namespaces with values, no
  constructor parameter properties, because type stripping cannot erase them.
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
- **Logging is LogTape, through `@7r/logging` only (ADR 0019).**
  `getLogger([ROOT_CATEGORY, ...])` at module scope is safe anywhere (an
  unconfigured logger is a silent no-op); `configureLogging` belongs in an entry
  point and **nowhere else**, once,
  because a second `configureSync` throws. A `console.*` in service code is now a
  defect, with two commented exceptions in `apps/worker/main.ts` that run before
  logging exists. The one-shot operator CLIs are the opposite case: their
  `console.log` output is a user interface printed to stdout, and it stays. The
  web image has one manifest, `apps/web/package.json`: Astro leaves only
  `better-auth`, `drizzle-orm` and `zod` external in `dist/server` and inlines
  the rest (`@logtape/logtape` included), and `scripts/check-externals.ts` runs
  in the image build and fails it if the bundle imports a package the image does
  not have.
- **The Discord interactions endpoint fails closed.** Verify the Ed25519
  signature over the raw request bytes (`timestamp + rawBody`) before parsing or
  acting on anything, and return 401 on *any* failure. Discord probes the
  endpoint with deliberately invalid signatures and removes the URL if one is
  ever answered 200: a silent, delayed bot death where nothing errors and the bot
  just stops receiving commands. `verifyInteractionSignature` (`@7r/discord`)
  never throws for exactly this reason. Deferred handlers run detached, so their
  `.catch` is mandatory: the web app installs no `unhandledRejection` handler and
  Node exits the process on one by default.

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
