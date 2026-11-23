# The worker image. Build context is the repo root (workspace member).
#
#   docker build -f apps/worker/Dockerfile -t 7r-worker .
#
# This image doubles as the one-shot migrator and legacy importer (the `migrate`
# and `import` services in compose.yaml override the command), which is why it
# carries packages/db/drizzle/: the runtime migrator reads that directory from
# disk. On Drizzle 1.0 it is one folder per migration
# (`<timestamp>_<name>/migration.sql` plus its snapshot). There is no
# meta/_journal.json any more (ADR 0016).

FROM node:26.13.1-trixie-slim AS build

# Node 25 and later no longer bundle corepack, so pnpm comes from npm. The
# version is pinned here, in the root package.json `packageManager` and in
# cd.yaml, and CI fails if they disagree.
RUN npm install -g pnpm@12.23.0

# WORKDIR creates /app owned by root, and the install then cannot create
# node_modules inside it. Own the directory before anything is written to it.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app

# --chown, and `USER node` BEFORE the install: run the install as the same user
# that will run the process, so nothing under /app is root-owned.
#
# The real workspace layout, not `pnpm deploy`. `deploy` copies the workspace
# packages into node_modules, and Node refuses to type-strip a `.ts` file whose
# real path is under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING),
# so every @7r/* import would fail at boot. Installed in place, node_modules/@7r/*
# stay symlinks to /app/packages/*, whose real path is outside node_modules.
#
# apps/web is not copied beyond its package.json: the filtered install below
# never touches it, but the frozen lockfile still lists it as a workspace member.
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY --chown=node:node packages/ ./packages/
COPY --chown=node:node apps/worker/ ./apps/worker/
COPY --chown=node:node apps/web/package.json ./apps/web/package.json
USER node

# Installs strictly from pnpm-lock.yaml and fails if it is stale. `--prod` leaves
# the dev dependencies (drizzle-kit, the linters) out, and `--filter
# @7r/worker...` limits the install to the worker and the workspace packages it
# depends on, so Astro and Starlight stay out of this image.
#
# The store lives in a BuildKit cache mount, so it survives between builds and
# stays out of the image. It is a different filesystem from /app, so pnpm copies
# files into node_modules instead of hard-linking them: the tree is
# self-contained, which the COPY into the runtime stage relies on.
#
# pnpm blocks dependency build scripts unless pnpm-workspace.yaml allows them,
# and `cpu-features` (ssh2's optional native addon, pulled in by the TeamSpeak
# client) is deliberately not allowed: the library runs pure JS without it.
# Never approve it; silencing the notice means putting a native toolchain in the
# image to build an addon we do not want.
RUN --mount=type=cache,target=/pnpm-store,uid=1000,gid=1000 \
    pnpm install --frozen-lockfile --prod --filter @7r/worker... --store-dir /pnpm-store

FROM node:26.13.1-trixie-slim AS runtime

# pnpm is not needed to run anything, so it stays in the build stage. /app is
# copied whole: node_modules holds relative symlinks (node_modules/@7r/* into
# packages/*, and into the .pnpm virtual store), which COPY preserves.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
COPY --from=build --chown=node:node /app ./
USER node

# Load every module the container can run, now, so a module that fails to load
# under Node (a missing dependency, a value-style import of a type-only export)
# fails the build rather than a restart at 03:00. This replaces what `deno
# cache` did. Nothing starts: main.ts, migrate.ts and import-legacy.ts only run
# under `import.meta.main`, so importing them just resolves their graphs.
RUN node --input-type=module -e "\
for (const specifier of [\
'./apps/worker/main.ts',\
'./packages/db/migrate.ts',\
'./packages/db/import-legacy.ts',\
]) { await import(specifier); console.log('loaded', specifier); }"

ENV NODE_ENV=production

EXPOSE 8080

# Node needs no permission flags, and every module is already on disk, so there
# is no registry to reach at boot.
CMD ["node", "apps/worker/main.ts"]
