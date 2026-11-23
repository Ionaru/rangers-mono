# Node.js 26 and pnpm 12 replace Deno as the runtime and the workspace tool

The platform runs on **Node.js 26** (pinned to 26.13.1, an Active LTS release) with **pnpm 12** workspaces, replacing Deno 2.9 and Deno's native workspaces. Node runs the TypeScript directly through its native type stripping: no `tsx`, and no build step for the shared packages, the worker or the operator CLIs. Tests are `node:test`, the typecheck is `tsc` (and `astro check` for `apps/web`), linting is ESLint and formatting is Prettier. Astro 7 keeps its SSR role, served by `@astrojs/node` in standalone mode instead of `@deno/astro-adapter`. The task interface is the root `package.json` scripts, run as `pnpm <name>`.

This supersedes the runtime and tooling half of [ADR 0006](0006-single-monorepo-deno-workspaces.md) (one monorepo with no meta build tool stands), supersedes the Deno-specific operational requirements in [ADR 0008](0008-drizzle-orm.md), and amends [ADR 0016](0016-drizzle-1-0.md) and [ADR 0019](0019-logtape-for-logging.md). The platform's behaviour does not change: no schema and no config key.

## Why

On 2026-10-09 Deno Land announced that it is joining Cloudflare (https://deno.com/blog/cloudflare). The Deno runtime gets one more year of monthly bug-fix and security releases, after which Deno Land ends its development; the runtime stays open source. Deno Deploy shuts down after six months, and JSR continues.

None of that breaks anything today, and the project does not use Deno Deploy or JSR. What it changes is the shelf life of the pin. This repo pins its runtime exactly, on purpose, and the runtime it pinned stops receiving security releases in about a year. A pinned runtime with no security releases is not something to run a production bot on, and the work of moving is the same whenever it is done. So the move happens before that date, on a calm schedule, rather than after it under a deadline.

Node 26.13.1 is the Active LTS line ("Lithium", LTS since 2026-10-28, end of life 2029-04-30), which is what an exact pin wants: a release line that will keep getting fixes for the life of the pin.

The move also removes every rule in this repo that existed only to bridge Deno and npm. `ssh2` and `node:crypto` now run on the runtime they were written for. Astro is built and run by the same runtime. Workspace members are plain `package.json` packages, with no second manifest beside them.

## What of ADR 0006 still stands

- **One repository, no meta build tool.** No Nx, no Turborepo, no task runner on top of pnpm. The coupling benefit (a shared identity, domain and database layer consumed by both the website and the worker) is unchanged.
- **The lesson from the abandoned predecessor.** A small dependency and tooling surface predicts whether a spare-time project survives. The Consequences below say what this decision costs against that, and what is there to keep it from rotting.
- **Pin the exact runtime and commit the lockfile**, now Node and pnpm and `pnpm-lock.yaml`.
- **If workspace resolution ever breaks, alias; do not add a build step.** `vite.resolve.alias` pointing each package at its source stays the escape hatch. A compiled-JS build step for the shared packages stays off the table.
- **No custom build orchestration**: package scripts and one Dockerfile per service.

## What this supersedes

- ADR 0006's runtime (Deno 2) and Deno workspaces, and "Deno is the default lens for new tooling decisions".
- The dual-manifest rule (every shared package carries a `deno.json` beside its `package.json`), and the Deno 2.9 floor for workspace symlinking. Every member is a plain `package.json` package listed in `pnpm-workspace.yaml`, linked by pnpm's `workspace:*`.
- "Build Astro with Deno, not Node" and `RUN deno cache`. Build and runtime are both Node, and nothing is fetched at boot.
- The exact Deno pin and `deno.lock`, and the `deno approve-scripts` rule (replaced below).
- In ADR 0008: "on Deno via `npm:` specifiers", the two Deno-specific drizzle-kit requirements (`nodeModulesDir` and `deno.json` imports), and the Deno pin bullet. `drizzle-kit` is an ordinary devDependency of `packages/db`.
- In ADR 0016: `deno task --cwd packages/db up` and the manifests the version bump touches. `packages/db/package.json` is the only manifest left.
- In ADR 0019: the argument that LogTape treats Deno as a first-class runtime, the `deno.json` and `apps/web/deno.prod.json` bullet, and `unhandledrejection` (now `process.on("unhandledRejection")`). LogTape stays because it is already integrated and has no dependencies; the choice is not reopened.

`deno task X` in the older ADRs (0009, 0014, 0016, 0018) reads as `pnpm X`. 0009, 0014 and 0018 are not edited for it; 0016's amendment note gives the new spellings because it was amended anyway.

## What Node's type stripping constrains

Node 26 runs `.ts` files by erasing the type syntax and executing what is left. Three rules follow from that, and all three fail at runtime if broken:

- **Node will not type-strip a `.ts` file whose real path is under `node_modules`** (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). A workspace package reached through a pnpm symlink resolves to `packages/<name>`, outside `node_modules`, and is stripped. A copied package is not. So the worker image installs in place and keeps the symlinks, and the web bundle inlines `@7r/*` (`vite.ssr.noExternal` in `astro.config.mjs`).
- **Type-only imports must be `import type`.** Node does not look at what an import resolves to, so a value-style import of a type-only export fails when the module loads. `tsc` enforces it with `verbatimModuleSyntax`.
- **Only erasable syntax.** No enums, no namespaces with values, no constructor parameter properties. `tsc` enforces it with `erasableSyntaxOnly`. Relative imports carry their `.ts` extension (`allowImportingTsExtensions`).

Node does not type-check, so `pnpm check` is `tsc` plus `astro check`.

## What replaced the guarantees Deno gave

Several things Deno did implicitly are explicit checks now, each one failing a build or an install rather than a request:

- **Frozen lockfile.** CI and both images install with `--frozen-lockfile`, which fails if `pnpm-lock.yaml` is stale.
- **Dependency build scripts.** `allowBuilds` in `pnpm-workspace.yaml` is the decision, and `strictDepBuilds` fails an install on a build script nobody has reviewed. It denies `cpu-features` (ssh2's optional native addon, which we do not want), `esbuild` and `ssh2`. Never run `pnpm approve-builds` and never set `dangerouslyAllowAllBuilds`. The `permissions` block in the same file denies the agent skills that `@logtape/logtape` and `drizzle-kit` offer to install.
- **The worker image.** A filtered production install that keeps the workspace symlinks, and a build-time smoke import of `main.ts`, `migrate.ts` and `import-legacy.ts`. It does what `deno cache` did: a module that fails to load fails the build, not a restart at 03:00. It is never built with `pnpm deploy`.
- **The web image.** `pnpm deploy --prod` for the runtime `node_modules`, and `scripts/check-externals.ts` in the image build, which fails it if `dist/server` imports a package the image does not have. Astro leaves only `better-auth`, `drizzle-orm` and `zod` external and inlines the rest, so `apps/web/package.json` is the one manifest.
- **The pins.** Node is in `.node-version` and every `FROM node:` of both Dockerfiles; pnpm is the root `package.json` `packageManager` and both Dockerfiles' `npm install -g pnpm@...` (Node 25 and later no longer bundle corepack). CI fails if any of them disagree.

## Considered and rejected

- **Stay on Deno until its development ends.** Security releases stop in about a year, and moving later is the same work done under a deadline. Nothing about staying buys anything the move does not.
- **`tsx`, `ts-node` or a compile step.** Node 26 strips types natively, so each is one more dependency to do what the runtime already does. A compiled-JS step for the shared packages is the build-system rot ADR 0006 exists to avoid.
- **Vitest.** `node:test` with `node:assert/strict` needs no dependency, and the suite uses none of what a framework adds.
- **Biome.** Its Astro support is partial. Prettier with `prettier-plugin-astro`, and ESLint with `eslint-plugin-astro`, cover `.astro` files, which is what `deno fmt` did.
- **`pnpm deploy` for the worker image.** It copies the workspace packages into `node_modules`, where Node refuses to strip their types. The web image can use it only because its bundle inlines them.
- **A hand-maintained runtime manifest for the web image.** That is `apps/web/deno.prod.json` again: a second list of what the image needs, kept in step with the first by a CI comparison. `apps/web/package.json` plus the externals check in the image build replaces the list and the comparison.

## Consequences

- **The tooling surface is larger than `deno` alone.** ADR 0006 named a small tooling surface as the survival predictor, and Deno bundled the runner, the typechecker, the linter, the formatter and the test runner. Node plus pnpm plus `tsc`, ESLint and Prettier is more than that, and that is the honest cost of this decision. What keeps it from rotting is one tool per job, exact pins everywhere (`saveExact`, the versions in `package.json`), a committed lockfile, and the CI checks above that fail on drift instead of waiting for someone to notice.
- **The task interface is `pnpm <script>`.** "No npm script layer" is reversed: the root `package.json` scripts keep the old task names, so `deno task X` becomes `pnpm X`, and pnpm forwards arguments without a `--` (`pnpm commands:register --apply`). `AGENTS.md`, `README.md`, `docs/IMPLEMENTATION.md` and `.vscode/launch.json` follow.
- **Things measured on Deno have not been measured on Node.** The full Discord login with no Astro session driver, `ts3-nodejs-library` over SSH against a live ServerQuery server (including `aes128-gcm@openssh.com`), and the logging verification in ADR 0019 were all done on Deno. The docs say so where they cite them. The first production run is the integration test, behind `SYNC_DRY_RUN` and the blast-radius guard, as ARCHITECTURE section 9 already says.
- **Both images carry `node_modules`.** The web image carries a production `node_modules` (about 780 MB at the time of the move, mostly Astro and Starlight, which could be trimmed by moving bundled dependencies to devDependencies) and the worker image a filtered production install (about 400 MB). ADR 0006's "no `node_modules` in the web image" is withdrawn.
- **`@astrojs/node` is pinned at 11.1.2**, the last release whose peer range accepts the pinned Astro 7.0.7. A newer adapter needs a newer Astro, so the two move together.
- **ADR 0003 is not reopened.** A gateway bot is easy on Node, but the reasoning (no always-on stateful Discord process is needed) did not change.
- **Revisit when** Node's type stripping or the Astro Node adapter changes in a way that breaks the no-build-step premise, or when a dependency needs a build script that `allowBuilds` has to say yes to.
