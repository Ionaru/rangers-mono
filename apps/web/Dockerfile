# The web image. Build context is the repo root: this is a workspace member and
# it consumes packages/* as source (ADR 0006).
#
#   docker build -f apps/web/Dockerfile -t 7r-web .

FROM denoland/deno:2.9.2 AS build
WORKDIR /app

# The whole workspace, because `deno ci` resolves every member listed in the
# root deno.json and will refuse to run if one is missing.
COPY deno.json deno.lock ./
COPY packages/ ./packages/
COPY apps/ ./apps/

# `deno ci` installs strictly from deno.lock and fails if the lockfile is stale.
#
# Never add `--allow-scripts` / `deno approve-scripts` here. From Phase 3 the
# TeamSpeak client pulls ssh2 -> cpu-features, whose ignored build script wants
# python and node-gyp. The "ignored build scripts" warning is correct behaviour:
# the library runs pure JS with zero native addons. Silencing it means putting a
# native toolchain in the image to build an optional addon we do not want.
RUN deno ci

# Build with Deno, never with Node. `npx astro build` emits an artifact that
# dies at boot on the Deno runtime ("Import 'unstorage' not a dependency")
# unless ~276 MB of node_modules ships into the runtime image. There is no Node
# builder stage, and adding one would manufacture that failure, not insure
# against it.
RUN cd apps/web && deno run -A npm:astro build

FROM denoland/deno:2.9.2 AS runtime

# WORKDIR creates /app owned by root, and `deno cache` writes a lockfile into
# it. Own the directory before anything is written to it.
RUN mkdir -p /app && chown deno:deno /app
WORKDIR /app

# The runtime config is NOT the root deno.json: that one declares workspace
# members which do not exist in this stage, and its nodeModulesDir:"auto" would
# re-materialise node_modules here. This one pins nodeModulesDir:"none" and maps
# exactly the bare specifiers Astro left external in entry.mjs (drizzle-orm,
# postgres, zod). Everything else, including @7r/db and @7r/config, was bundled
# into dist by Rolldown.
#
# --chown, and `USER deno` before the cache step: populate DENO_DIR as the user
# that will run the process. Cache as root and the cache is root-owned, so Deno
# silently re-fetches everything at container start, which is exactly the cold
# boot this step exists to prevent.
COPY --chown=deno:deno apps/web/deno.prod.json ./deno.json
COPY --from=build --chown=deno:deno /app/apps/web/dist ./dist
USER deno

# Cache the server entry at image-build time. Without this a cold start pulls
# ~119 files from jsr.io, which means a jsr.io outage takes the container down
# on any restart (ADR 0006). It also fails loudly right here if deno.json is
# missing a specifier that entry.mjs needs.
RUN deno cache dist/server/entry.mjs

# No node_modules in this stage, by design. Verify with:
#   docker run --rm --entrypoint sh 7r-web -c 'ls -a /app'
EXPOSE 8085

# --cached-only enforces what the `deno cache` above bought: every module comes
# from the image, and a jsr.io or npm outage cannot stop this container booting.
CMD ["run", "--cached-only", "--allow-net", "--allow-read", "--allow-env", "--allow-sys", "dist/server/entry.mjs"]
