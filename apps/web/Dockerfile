# The web image. Build context is the repo root: this is a workspace member and
# it consumes packages/* as source (ADR 0006).
#
#   docker build -f apps/web/Dockerfile -t 7r-web .

FROM node:26.13.1-trixie-slim AS build

# Node 25 and later no longer bundle corepack, so pnpm comes from npm. The
# version is pinned here and in the root package.json `packageManager`; CI
# (cd.yaml) fails if they disagree.
RUN npm install -g pnpm@12.23.0
WORKDIR /app

# The workspace members @7r/web depends on, plus the web app itself. The other
# apps are not copied: the frozen lockfile still lists apps/worker, so its
# manifest has to be there, and only its manifest.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ ./packages/
COPY apps/web/ ./apps/web/
COPY apps/worker/package.json ./apps/worker/package.json

# Installs strictly from pnpm-lock.yaml and fails if it is stale, filtered to the
# web app and what it depends on (the build needs the dev dependencies too).
#
# The store lives in a BuildKit cache mount, so it survives between builds and
# stays out of the image.
#
# pnpm blocks dependency build scripts unless pnpm-workspace.yaml allows them.
# `cpu-features` (ssh2's optional native addon, pulled in via the TeamSpeak
# client) is deliberately not allowed: the library runs pure JS without it.
# Never approve it, and do not add a native toolchain to build it.
RUN --mount=type=cache,target=/pnpm-store \
    pnpm install --frozen-lockfile --filter @7r/web... --store-dir /pnpm-store

RUN pnpm --filter @7r/web build

# A production-only node_modules for the runtime stage. Astro leaves a few
# packages external in dist/server (better-auth, drizzle-orm and zod), and Node
# resolves those from node_modules at runtime. `deploy` also copies the @7r/*
# packages into that node_modules, which is harmless here and nowhere else: the
# build inlines them (vite.ssr.noExternal in astro.config.mjs), so nothing under
# node_modules is ever loaded as raw `.ts`. The worker image cannot do this.
RUN --mount=type=cache,target=/pnpm-store \
    pnpm --filter @7r/web deploy --prod --store-dir /pnpm-store /out

FROM node:26.13.1-trixie-slim AS runtime

# WORKDIR creates /app owned by root; own it before anything is copied in.
RUN mkdir -p /app && chown node:node /app
WORKDIR /app

# No pnpm here: nothing at runtime needs it. node_modules holds relative
# symlinks into its own .pnpm directory, which COPY preserves.
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/web/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/scripts/check-externals.ts ./scripts/check-externals.ts
USER node

# Fail the build, not the first request, if the bundle imports a package this
# image does not have. Astro decides what stays external, so a new dependency can
# turn into a bare import in dist/server without anyone touching this file; it
# would otherwise only fail when the route that loads it is first hit. This
# replaces `deno cache` failing on a missing specifier.
RUN node scripts/check-externals.ts dist/server

# The standalone adapter reads HOST and PORT at runtime. HOST is not optional:
# without it the server binds loopback only, and neither the published port nor
# the healthcheck can reach it.
#
# NODE_ENV is deliberately left unset, as it was on Deno. Better Auth reads it
# at runtime: "production" swaps its error page for a bare redirect to
# /?error=<code> (a failed login would land on the homepage unexplained) and
# turns on its in-memory rate limiter. apps/web/src/lib/auth.ts sets what it
# needs (the Secure cookie) explicitly instead.
ENV HOST=0.0.0.0 PORT=8085

EXPOSE 8085

# Node needs no permission flags, and every module is already on disk, so there
# is no registry to reach at boot.
CMD ["node", "dist/server/entry.mjs"]
