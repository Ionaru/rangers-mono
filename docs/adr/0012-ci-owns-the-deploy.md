# CI owns the deploy, and the deploy script knows the box is Windows

Deploying is not left to the operator: `.github/workflows/cd.yaml` SSHes into the box on every push to `main` and runs the deploy itself (`git switch -d <sha>`, `docker compose pull`, the one-shot `migrate` profile, `up -d`). The script is **PowerShell**, because the box is Windows with Docker Desktop.

This narrows ADR 0005. Infrastructure is still out of scope: the platform does not own the host, the reverse proxy, TLS, or boot behaviour. What it now owns is the **act of deploying** to whatever host the operator points it at.

## Why

ADR 0005 drew the boundary at the Compose file and left hosting to the operator, but it never said who runs `docker compose pull && up -d`, and ARCHITECTURE §6 already prescribes exactly that command "pinned to a commit SHA". Someone has to type it. For a solo spare-time project, the realistic alternatives were a manual deploy (remembered on a Saturday, in the wrong order, without the migrate step) or a scripted one. The migration step in particular is easy to skip by hand, and skipping it is precisely the failure ADR 0008 is written to avoid: migrations never run on boot, so nothing else will catch it.

The honest cost is that the script encodes one fact about the host, its shell. That fact was going to live somewhere regardless: the alternative is a `deploy.ps1` on the box, which is the same coupling with no version control and no review.

## What this ADR does not sanction

- **No `docker system prune`, and nothing else daemon-wide.** The box already runs the operator's nginx, the old Discord bot and the old website (ARCHITECTURE §9). A host-wide prune reaps every stopped container, every image not currently backing a running one, and the shared build cache, so it breaks the next restart or rebuild of stacks this project does not own. Reclaiming disk on that box is an operator decision. The deploy touches this project's Compose stack and nothing else.
- **No new host knowledge.** The deploy learns the shell and `DEPLOY_PATH` (a secret, so the box's directory layout is not published in a workflow file). It does not learn the proxy, the TLS setup, or the boot behaviour, all of which stay with the operator.

## Considered and rejected

- **Manual deploys.** Rejected: the three steps have an order (pull, migrate, up), and the middle one is the one a human skips. See ADR 0008.
- **A host-agnostic POSIX script.** Rejected as a fiction: the box is Windows with Docker Desktop today, so a `sh` script would simply not run. Writing one to satisfy the wording of ADR 0005 buys portability we cannot test and lose nothing by deferring.
- **Watchtower / auto-pull on the box.** Already rejected in ARCHITECTURE §6 for our own images: a deploy should be a decision with a SHA on it, not a daemon noticing a tag moved.

## The interactive-session problem bites twice

ADR 0005 records that Docker Desktop's **engine** only starts inside an interactive Windows login session. The same is true of its **credential helper**, and that one is not a background risk, it fires on every deploy. `docker-credential-desktop` reads the Windows Credential Manager, which does not exist in a non-interactive SSH session, so it exits non-zero with `A specified logon session does not exist` and takes `docker compose pull` with it.

This went unnoticed for as long as the deploy discarded exit codes: `pull` failed, nothing checked, and `up --pull=never` then ran against whatever images the box happened to have. Checking the exit codes (ADR 0013) is what surfaced it.

The deploy therefore points `DOCKER_CONFIG` at a directory it writes itself, holding a `config.json` with no `credsStore`. No credentials are needed by anything here: the GHCR packages inherit the repository's visibility and are public, and postgres comes from Docker Hub. The operator's own `~/.docker/config.json` is untouched, and a fresh box needs no preparation. (The sibling `fruiz` deploy solves this with a hand-made `/docker-no-creds` on the box; writing it is the same fix without the undocumented prerequisite.)

**If the repository is ever made private, this breaks**, and the fix is a `docker/login-action`-style `docker login ghcr.io` with a PAT into that same `DOCKER_CONFIG`, not a return to the Desktop helper.

## Consequences

- **ADR 0005's "needs no code change" is amended.** Moving the stack to a Linux host is still cheap, but it is no longer free: the Compose file and the env vars carry over untouched, and the deploy script's shell has to be rewritten (PowerShell to `sh`). That is one file, and it is the only thing on the platform side that knows the host.
- The deploy is SHA-pinned in both directions: the images are tagged with the short SHA, and the box checks out that same SHA so the Compose file it runs matches the images it pulls.
- Disk on the box grows with old images. That is the operator's to reclaim, deliberately (see above).
- The known hazard stays the operator's, unchanged and unsolved here: Docker Desktop's engine only starts inside an interactive Windows login session, so after an unattended reboot there is no daemon and the stack stays down silently (ADR 0005, recorded risk 1). CI will deploy happily into a box with no engine and report success on the SSH step but nothing will be running.
