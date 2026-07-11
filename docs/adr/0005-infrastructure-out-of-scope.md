# Infrastructure is out of scope: the platform ships a Compose file

The project's infrastructure deliverable is a `docker-compose.yml` (web, Postgres, worker) and nothing more. Where and how it runs (which host, which Docker distribution, how it starts on boot, TLS, the reverse proxy) is an operational concern owned by whoever runs the box, not an architectural decision this project makes.

## Why

ADR 0007 removed the last thing that needed the game box: attendance is TeamSpeak-based, so there is no Arma RPT bind-mount and no inotify across the Windows/WSL2 boundary. Every integration (Discord, TeamSpeak ServerQuery, Steam OpenID) is over the network. Nothing in the platform is coupled to a particular host any more.

For a solo spare-time project, owning an infrastructure workstream is a cost with no product return. The unit's pain is hand-managing TeamSpeak groups, not deployment topology. So the project draws its boundary at the Compose file and lets the operator make the hosting call.

## Context that remains true

- The target box today is the **Windows Arma game server**. It already runs Docker + nginx + Let's Encrypt fronting containers, so the `web` service slots in as another upstream and **TLS is already solved**. No new reverse proxy is introduced.
- **Postgres runs on a Docker volume.**
- Public exposure of 80/443 is already the status quo (the current site and the game server are already reachable).

## Recorded risks the operator owns

Documented, not solved. These are hosting decisions, and this ADR does not make them.

1. **Docker Desktop's engine only starts inside an interactive Windows login session.** See docker/roadmap#515 (open since 2023-07-24), where a Docker contributor states plainly that unattended start "would not be possible with Docker Desktop" and points to Docker Engine instead. After an unattended reboot, e.g. a 3am Windows Update, there is no daemon, so `restart: unless-stopped` never fires and the whole stack stays down **silently**. If that happens on a Saturday, the op's attendance simply does not exist and no error is raised anywhere. Mitigations available to the operator: run Docker Engine inside WSL2 as a service, enable auto-login, or move the stack off the game box.
2. **Resource contention.** Postgres and Astro SSR would share the box with a latency-sensitive, largely single-threaded simulation during ops. Note that per-container CPU/memory limits do **not** fence the WSL2 VM itself, which is governed by `.wslconfig`.
3. **Docker Desktop commercial licensing** thresholds, for the operator to judge.

## Considered and rejected

- **Introducing Caddy for TLS.** Unnecessary on the current box: it already terminates TLS via nginx + Let's Encrypt. Reuse it. If the stack moves to a host without a proxy, that is the operator's choice to make and the Compose file does not presume one.
- **Making the game box an architectural commitment.** Rejected: nothing depends on it. Pinning the design to a host would buy a constraint for free.

## Consequences

- **The project's deliverable is the Compose file.** Host selection, boot behaviour, TLS termination, and monitoring live with the operator.
- **There is no hardening phase.** Backups are cut and infrastructure is out of scope. What is left of the old Phase 7 (log rotation, error-to-Discord alerts) folds into the phases that need it.
- **Splitting the stack onto a separate host is a cheap change at any time and needs no code change**: point the Compose file at a Linux box, keep the same env vars.
