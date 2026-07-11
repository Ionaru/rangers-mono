# One monorepo on Deno with native workspaces, no meta build tool

The platform is a single git repository using Deno 2 as the runtime and Deno's built-in `workspace` field for multiple packages. There is no Nx, Turborepo, or other meta build tool. The Astro site is a `package.json` workspace member, and so is every shared package it consumes; the remaining packages are Deno-only.

## Why

The owner asked for a monorepo "only if it provides a clear benefit over a monolith". The benefit is concrete and specific: a shared identity/domain/database layer is consumed by both the website and the background worker. Multi-repo would tax exactly that coupling (every schema change becomes a publish-and-bump across repos). Deno's native workspaces give cross-package imports, one lockfile, and repo-wide `fmt`/`lint`/`test` with zero added tooling. Deno workspaces officially support a `package.json` member, so the Astro app coexists.

The runtime is Deno because the owner prefers it and, with the bot running HTTP-only (ADR 0003), nothing forces Node: no always-on stateful process is needed. Astro 7 runs under Deno via the official `@deno/astro-adapter`, and the Astro build itself is run with Deno (`deno run -A npm:astro build`).

## The lesson from the abandoned predecessor

The prior attempt (`rangers-site`) was an Nx monorepo and it died of build-system rot, not of being one repo: a hand-maintained entity list, EOL toolchain, and an Nx/plugin ecosystem that greeted the maintainer with a broken build after months away. What predicts survival of a spare-time project is a *small dependency and tooling surface*, not repo count. So: one repo for the coupling benefit, but the lightest possible tooling on top of it.

## Consequences

- Deno is the default lens for new tooling decisions; reach for npm packages via `npm:`/`node:` only when Deno-native options are worse.
- **Every shared package that `apps/web` consumes (`db`, `domain`, `discord`, `identity`, `config`) needs a `package.json` alongside its `deno.json`.** Astro's bundler cannot resolve a workspace member that only has a `deno.json`: the build fails with `Rolldown failed to resolve import "@7r/db"`. With both files present, Astro resolves the package natively and the Deno members still resolve it. So the npm/Deno boundary is *not* contained to `apps/web`; it touches every shared package the website imports. This is load-bearing: the monorepo's only justification is a shared domain/db layer consumed by both website and worker, and without the dual manifest the website cannot consume it.
- **Build Astro with Deno, not Node.** `npx astro build` emits an artifact that dies at boot under Deno (`error: Import "unstorage" not a dependency`) unless roughly 276 MB of `node_modules` is shipped into the runtime image. `deno run -A npm:astro build` emits a self-contained artifact that boots from a slim image. A "Node build stage as insurance" is not insurance, it manufactures the failure; there is none.
- Add `RUN deno cache dist/server/entry.mjs` at image-build time. Without it a cold container start pulls 119 files from jsr.io, so a jsr.io outage takes the container down on restart.
- **Pin the exact Deno version and commit `deno.lock`.** The npm-under-Deno surface the project does take on is `ts3-nodejs-library` -> `ssh2` -> `node:crypto`. It works, verified end to end against a live ServerQuery server, but a real TeamSpeak negotiates `aes128-gcm@openssh.com`, exactly the code path Deno broke three times and only repaired in February 2026 (denoland/deno#32290). A floating Deno version is the most likely way this repo breaks while nobody is looking.
- Never run `deno approve-scripts` / `--allow-scripts`. The yellow "ignored build scripts" warning is correct behaviour: `cpu-features` wants python and node-gyp, and it is optional.
- No custom build orchestration: `deno task` + per-service Dockerfiles.
