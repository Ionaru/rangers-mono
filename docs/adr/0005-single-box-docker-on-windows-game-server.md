# The whole stack runs in Docker on the Windows game server

The website, Postgres, and the Discord/TeamSpeak worker run as containers (Docker Desktop, Linux containers) on the same self-hosted Windows machine that runs the Arma 3 dedicated server, behind the nginx reverse proxy already running there.

## Why

The owner chose a single box for operational simplicity, and that box already hosts a Docker + nginx (Let's Encrypt) setup fronting other containers, so the new services slot in as additional upstreams with TLS already solved.

Note: with attendance now coming from TeamSpeak (ADR 0007), **nothing in the platform technically needs to be on the game box** any more (all integrations are over the network). Co-location is now an infrastructure-reuse and simplicity choice, not a requirement. This makes splitting the stack onto a separate host a cheap change later if desired.

## Considered and rejected

- **Split: web/DB/worker on a separate Linux host.** Protects the latency-sensitive game server from web/DB load. Rejected by the owner in favour of reusing the existing single-box Docker/nginx setup; kept documented as an easy change if the game server suffers during ops.
- **Introducing Caddy for TLS.** Unnecessary: the box already terminates TLS via nginx + Let's Encrypt. Reuse it.

## Consequences

- **Reverse proxy is the existing nginx + Let's Encrypt entrypoint;** the new `web` service is added as an upstream. No Caddy.
- **Docker Desktop for Windows** (Linux-container mode). Note its commercial-use licensing and Windows-filesystem mount performance if that ever matters.
- **No Arma RPT bind-mount** is needed (attendance is TeamSpeak-based), which removes the trickiest part of the original single-box plan (inotify across the Windows/WSL2 boundary).
- **Resource contention** remains the one real risk: Postgres and Astro SSR share the box with a latency-sensitive, largely single-threaded simulation during ops. Set container CPU/memory limits and watch server FPS during the first few ops.
- Public exposure of 80/443 is already the status quo (the current site and game server are already reachable).
