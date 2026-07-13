# The worker image. Build context is the repo root (workspace member).
#
#   docker build -f apps/worker/Dockerfile -t 7r-worker .
#
# This image doubles as the one-shot migrator (the `migrate` service in
# compose.yaml overrides the command), which is why it carries
# packages/db/drizzle/: the runtime migrator reads that directory from disk. On
# Drizzle 1.0 it is one folder per migration (`<timestamp>_<name>/migration.sql`
# plus its snapshot). There is no meta/_journal.json any more (ADR 0016).

FROM denoland/deno:2.9.2 AS runtime

# WORKDIR creates /app owned by root, and `deno ci` then cannot create
# node_modules inside it. Own the directory before anything is written to it.
RUN mkdir -p /app && chown deno:deno /app
WORKDIR /app

# --chown, and `USER deno` BEFORE the install: run the install as the same user
# that will run the process. Installing as root and then dropping to `deno`
# leaves DENO_DIR and node_modules root-owned, and Deno then re-does the whole
# setup at container start: it re-downloads every npm package (so a registry
# outage becomes a boot failure) and dies on
# `File exists (os error 17), symlink '../../packages/config'`.
COPY --chown=deno:deno deno.json deno.lock ./
COPY --chown=deno:deno packages/ ./packages/
COPY --chown=deno:deno apps/ ./apps/
USER deno

# Installs strictly from deno.lock and fails if it is stale.
#
# Never add `--allow-scripts` / `deno approve-scripts`. From Phase 3 the
# TeamSpeak client pulls ssh2 -> cpu-features, whose ignored build script wants
# python and node-gyp. The warning is correct behaviour: the library runs pure
# JS with zero native addons and only --allow-net.
RUN deno ci

# Resolve and cache every module now, so a failure surfaces at build time rather
# than at 03:00 on a restart.
RUN deno cache apps/worker/main.ts packages/db/migrate.ts

EXPOSE 8080

# --cached-only: resolve every module from the cache baked in above, and never
# reach the network for one. Without it Deno re-fetches npm metadata on every
# boot, which turns a registry outage into a container that will not start.
#
# --allow-sys: postgres.js reads os.userInfo() when the connection string
# carries no user.
CMD ["run", "--cached-only", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "apps/worker/main.ts"]
