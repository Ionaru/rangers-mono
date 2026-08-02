# Logging goes through LogTape, and `LOG_LEVEL` starts meaning something

Both services log through **`@logtape/logtape`, pinned to 2.3.0**, reached only through a new workspace package, `@7r/logging`, which owns the dependency and the policy. Every module that logs calls `getLogger(["7r", ...])` at module scope; every entry point calls `configureLogging` exactly once. The `log: (message, extra) => void` callback that was threaded through six modules is gone. The `alert` callback is not, and that asymmetry is the point (see below).

The immediate reason is smaller than the machinery: **`LOG_LEVEL` has been shipping as a lie.** It is declared in `coreSchema`, validated, covered by four tests, passed to both containers by `compose.yaml`, documented in `.env.example` as a `[VAR]`, and set in the production GitHub Environment (ADR 0018). Nothing has ever compared anything against it: its one and only reader printed it back inside the "worker started" line. `LOG_LEVEL=warn` on the box today does exactly nothing.

## Why

Three problems, one of which is the config lie above.

**The two services do not agree on what a log line is.** The worker had a five-line JSON-lines helper in `main.ts` and passed it down as a parameter. `apps/web` had five `console.error` calls with `[web]`/`[discord]` string prefixes and no structure at all. One box, one `docker compose logs`, two formats, and the website's half unparseable.

**A threaded logger cannot reach the code that most needs one.** The Discord interactions endpoint answers in under three seconds and runs the slow half of the work **detached** (`lib/discord/respond.ts`); by the time that work fails, the request is over. There was nothing to tie its error line to the interaction that caused it, and no parameter could have been threaded that far, because the thing that needs the context is a `.catch` on a promise nobody is holding. LogTape's `withContext` plus `AsyncLocalStorage` attaches the interaction id once, at the endpoint, and it follows the work. That is now the only mechanism in the codebase that spans that gap.

**The plumbing was load-bearing for nothing.** Five modules took a `log` parameter (`sync.ts`, `weekly-event.ts`, `internal-api.ts`, `alert.ts` and `packages/teamspeak/client.ts`) and `main.ts` existed to supply it, purely to pass one function downward, including through `Pick<>` types on six private helpers in `weekly-event.ts` that wanted nothing else from `deps`.

## Why this library and not another

Zero dependencies, MIT, and it is the rare logging library that treats Deno as a first-class runtime rather than a Node emulation: the package resolves `Deno.inspect` through an `imports` condition, and 122 KB of ESM arrives with no transitive anything. That matters more here than features. The whole argument of ADR 0006 is that a spare-time project survives on a small dependency surface, and a logger that drags in transports and Node stream shims would have been a worse trade than the five-line helper it replaces.

It was verified, not assumed, on the pinned Deno 2.9.2: `deno check` clean, the built `dist/server/entry.mjs` boots under `--cached-only` and logs, `configureLogging` leaves no live handle that would hold the worker's event loop open through a SIGTERM, and an implicit context genuinely survives into a detached promise created inside it.

**Library-first is what makes a module-scope `getLogger` safe.** An unconfigured LogTape logger emits nothing, allocates nothing and reads no environment, so a package can hold one at module scope without deciding anything for the process that imports it, and without tripping the rule that `astro build` executes module code. Nothing in `packages/*` calls `configureLogging`; only the four entry points do.

## The logger became global. The alerter did not

`makeAlerter` still takes its webhook and still gets handed to `runSyncPass`, and the loops still wrap it before passing it down. That is deliberate: an alerter is not a transport, it is policy about what is worth waking somebody for, and `startSyncLoop` wraps the one it is given in a leaky bucket and an episode latch (`sync.ts`) so a standing fault pages once rather than 288 times a day. A module-scope alerter would let any call site page straight around all of it. A logger has no such policy to route around, which is exactly why it can be global.

## Two `console.error` calls stay, on purpose

Both are in `apps/worker/main.ts`, and both are the paths that run when logging itself may not exist yet: the `unhandledrejection` handler, armed at module scope before any config is parsed, and the fatal-startup `catch`. The most likely thing to fail at boot is the config parse, and the config parse is what decides the log level, so the failure that matters most is precisely the one a configured logger might not be there to report. Everywhere else, a `console.*` call in service code is now a bug.

## What an operator will see change

- **The line shape.** `{"ts","msg",...extra}` becomes `{"@timestamp","level","message","logger","properties"}`, with the extras nested under `properties` rather than flattened. Nothing consumes these programmatically (Docker's `json-file` driver, 10 MB x 3), so the cost is muscle memory.
- **`LOG_LEVEL` filters.** `warn` and `error` now genuinely suppress. The four accepted values are unchanged, so no production variable needs editing; `warn` is translated to LogTape's `warning` inside `@7r/logging` rather than widening the env schema to levels nothing logs at.
- **The dry-run diff moved to `debug`, and is the only line below `info`.** It was one line per changed member per pass, forever, while `SYNC_DRY_RUN` is true, which is the default and where this system spends its first weeks. The per-pass summary keeps the counts, `sync:preview` prints the whole diff on demand (which is the gate ADR 0009 actually points at), and `LOG_LEVEL=debug` brings it back.
- **Messages stayed constant strings**, with the varying data in the properties object, rather than moving to LogTape's `{placeholder}` interpolation. Same reason the alert summaries are constant: a message that carries a count or a name is a message you cannot grep for, and this codebase already made that decision once.

## Considered and rejected

- **Ten lines to make `LOG_LEVEL` work.** The honest alternative, and the strongest one: comparing a level ordinal inside the worker's existing helper fixes the largest defect found here with no dependency and no manifest churn. Rejected because it fixes the worker only. `apps/web` would still have no structured logging and no way to correlate a detached handler's failure with the interaction that caused it, and that gap is the one that costs an evening when a `/link` starts failing.
- **Pino or Winston.** Both assume Node streams and transports. On Deno that is a compatibility surface to babysit for features this project does not want, against a library that has none of it.
- **A homegrown `@7r/logging` with no dependency.** Levels and JSON lines are easy; hierarchical categories, an async-context store and a formatter worth reading are the parts that would actually get written badly and then maintained forever.
- **The satellite packages** (`@logtape/otel`, `@logtape/sentry`, `@logtape/file`, `@logtape/redaction`, `@logtape/pretty`). Docker's `json-file` driver is already the sink and ADR 0005 puts infrastructure out of scope. Each is one line in one manifest on the day it is wanted.
- **Replacing the alerter with a filtered LogTape sink.** The webhook is not the interesting part of `alert.ts`; the de-duplication in `sync.ts` is, and it is domain policy that does not belong in a sink.
- **Converting the operator CLIs.** 129 of the repo's 137 `console.*` calls are in one-shot scripts (`sync:preview`, `op:preview`, `ts:check`, `badges:backfill`, `assignables:seed`, `env:check`, `phase0:check`, `commands:register`, `import:legacy`, `migrate`). That is a user interface printed to stdout for a human at a terminal, not logging, and a mechanical sweep would have wrecked it. Every one of them is untouched.

## Consequences

- **One dependency, seven files.** ADR 0006's dual-manifest rule means `@logtape/logtape` lands in `packages/logging/package.json`, the package is listed in the root `deno.json` workspace **and** its `check` task, `apps/web/package.json` gains `@7r/logging`, and `apps/web/deno.prod.json` gains the npm pin. That last one is not optional and not obvious: Astro leaves `@logtape/logtape` external in `entry.mjs` (workspace packages are bundled, npm dependencies are not), so without the entry the runtime image fails at `deno cache`. A `check @logtape/logtape packages/logging/package.json` line was added to the pin-consistency job in `cd.yaml` so the two pins cannot drift.
- **`console.*` in service code is now a defect.** It bypasses the level, the categories and the context. The two exceptions above are commented as such where they live.
- **Categories are the knob.** `["7r","worker","sync"]`, `["7r","worker","event"]`, `["7r","worker","api"]`, `["7r","worker","alert"]`, `["7r","teamspeak"]`, `["7r","web"]`, `["7r","web","auth"]`, `["7r","web","discord"]`, `["7r","web","steam"]`. Turning one subsystem up without drowning in the rest needs a per-category entry in `configureLogging`, which nothing passes yet; `LOG_LEVEL` sets the floor for all of them.
- **`apps/web` configures logging from middleware**, because Astro has no startup hook. It sits below the prerender guard (the build has no environment to read `LOG_LEVEL` from) and above the interactions short-circuit (that endpoint is the loudest thing in the app). `configureLogging` is memoised, so every request after the first is a boolean check, which it has to be: a second `configureSync` throws.
- **Revisit when a second reader appears.** The moment anything other than a human reads these lines (a shipper, an OTel collector, Sentry), the JSON shape becomes an interface and the satellite packages stop being speculative.
