# One monorepo on Deno with native workspaces, no meta build tool

The platform is a single git repository using Deno 2 as the runtime and Deno's built-in `workspace` field for multiple packages. There is no Nx, Turborepo, or other meta build tool. The Astro site is a `package.json` workspace member; everything else is Deno.

## Why

The owner asked for a monorepo "only if it provides a clear benefit over a monolith". The benefit is concrete and specific: a shared identity/domain/database layer is consumed by both the website and the background worker. Multi-repo would tax exactly that coupling (every schema change becomes a publish-and-bump across repos). Deno's native workspaces give cross-package imports, one lockfile, and repo-wide `fmt`/`lint`/`test` with zero added tooling. Deno workspaces officially support a `package.json` member, so the Astro app coexists.

The runtime is Deno because the owner prefers it and, with the bot running HTTP-only (ADR 0003), nothing forces Node: the one fragile spot (the Discord gateway on Deno) is avoided by design. Astro 7 runs under Deno via the official `@deno/astro-adapter`; a Node build stage is kept as insurance for the Astro build step.

## The lesson from the abandoned predecessor

The prior attempt (`rangers-site`) was an Nx monorepo and it died of build-system rot, not of being one repo: a hand-maintained entity list, EOL toolchain, and an Nx/plugin ecosystem that greeted the maintainer with a broken build after months away. What predicts survival of a spare-time project is a *small dependency and tooling surface*, not repo count. So: one repo for the coupling benefit, but the lightest possible tooling on top of it.

## Consequences

- Deno is the default lens for new tooling decisions; reach for npm packages via `npm:`/`node:` only when Deno-native options are worse.
- The Astro member uses npm tooling for its build; the rest of the repo uses `deno.json` tasks. This split is contained to the `apps/web` package.
- No custom build orchestration: `deno task` + per-service Dockerfiles.
