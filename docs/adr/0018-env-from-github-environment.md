# The box's `.env` is generated at deploy from a `production` GitHub Environment

Application config moves off the box. Instead of a hand-maintained `.env`, each value
is an entry in a GitHub **`production` Environment**: non-secret values as
**variables** (viewable and editable in the UI), credentials as **secrets**
(write-only). The deploy job assembles `.env` from `toJSON(vars)` + `toJSON(secrets)`,
excluding the operational deploy secrets, and writes it to the box before any
`docker compose` command. Compose still loads it with `env_file: .env` (ADR 0014 is
otherwise unchanged); the database's file-based `./secrets/` stay exactly as they are.

## Why

ADR 0014 made the box `.env` the load-bearing, hand-maintained secret store, and
named the sharp edge itself: "if it is lost, it is lost." Keeping it in sync as config
grows means editing a file on a Windows box over SSH, and its stated fallback, recopy
`.env.example` and re-enter every value, is a lot of manual, error-prone work for one
person in spare time. The whole point of this ADR is to make config editable from
GitHub and the box `.env` reproducible.

GitHub secrets are **write-only**: you cannot read a stored value back, only overwrite
it. That is the constraint the design turns on. A single secret holding the whole
`.env` would therefore be *worse* than the box file, because changing one value means
re-entering the entire blob blind. So config is **one entry per value**, each
overwritten independently: rotate the bot token by setting one secret, and nothing
else is touched.

Two further choices fall out of that:

- **A `production` Environment, not repo-level secrets.** Environment entries are
  exposed only to a job that declares `environment: production`, so a future
  PR-triggered job cannot read production credentials; they are grouped in the UI
  apart from the operational `DEPLOY_*` repo secrets; and the environment is where
  optional protections (restrict deploys to `main`, require a reviewer) attach if ever
  wanted. Environment entries merge into the same `vars`/`secrets` contexts as
  repo-level ones (hence GitHub's documented env > repo > org precedence), so
  `toJSON` still sees them.
- **Split secret from non-secret.** Most keys are not sensitive (log level, base URL,
  ids, hosts, ports, timezones, flags, thresholds, paths). Those become **variables**,
  which are viewable and editable in the UI, the direct answer to the write-only pain.
  Only things that authenticate or authorize become **secrets**. `.env.example`
  records which each key is.

To keep *adding* a key from churning the workflow, the runner assembles `.env` from
`toJSON(vars)` and `toJSON(secrets)` rather than naming each key, selecting by
excluding the operational secrets (`DEPLOY_*`, `GITHUB_TOKEN`). Adding a config value
is then just adding one variable or secret; the workflow does not change. The
assembled file is validated by `deno task env:check` on the runner **before the box is
touched**, so a forgotten required entry fails the deploy loudly instead of stopping
the app and then crash-looping the worker on fail-loud config. It reaches the box as a
single-line base64 string (values single-quoted so Compose reads them literally,
ADR 0014), which is what survives interpolation through SSH into PowerShell intact.

## Considered and rejected

- **One secret holding the whole `.env`.** The obvious first idea, and the one this
  ADR exists to reject: secrets are write-only, so editing a single value means
  rewriting the entire blob without being able to see what is already in it. Strictly
  worse than the box file it replaces.
- **Name every key explicitly in the workflow** (`DISCORD_BOT_TOKEN: ${{ secrets.… }}`
  …). Robust and self-documenting, but adding a config key then means editing
  `cd.yaml` as well as adding the secret. The `toJSON` + exclude-rule keeps new keys
  zero-touch; `env:check` and the exclude-rule's warning comment cover the loss of
  explicitness.
- **Drop the `.env` file entirely**, injecting each value via Compose `environment:`
  interpolation. Moves the per-key churn into the committed, public `compose.yaml`,
  and breaks the host-side `deno task` flows (`migrate`, `web:dev`) that ADR 0014
  keeps `.env` for. Keeping the file and changing only its *source* costs nothing here
  and touches neither.
- **Move the database credentials to GitHub too.** ADR 0014 keeps `postgres_password`
  and `database_url` as file-based `./secrets/` precisely because they are already
  deployed and working, and moving a live credential to prove a point is how a green
  deploy goes red. Unchanged. The containers read the URL via `DATABASE_URL_FILE`, so
  the generated `.env` omits `DATABASE_URL` altogether.
- **A real secret manager** (Vault, SOPS, Swarm secrets). Infrastructure, out of scope
  (ADR 0005), already rejected in 0014. This reuses the CI the deploy already runs on
  and adds nothing to operate.

## Consequences

- **The box `.env` is now reproducible**, which amends ADR 0014's "if it is lost, it
  is lost." Losing it is a redeploy, not an evening of gathering values from Discord,
  TeamSpeak and memory. The GitHub Environment is the source of truth; the box file is
  derived and is **overwritten on every deploy**, so it must not be hand-edited.
- **Changing config is a GitHub action, not a box action.** Edit a variable in the UI
  (you can see its current value) or overwrite a secret; add a key by adding one
  variable or secret, with no `cd.yaml` change. `deno task env:check` locally, or the
  deploy's own gate, tells you if a required entry is missing.
- **The exclude-rule is load-bearing.** Any future *non-config* secret added at repo
  level must be added to the assembly's exclude, or its value would land in `.env`.
  The rule currently drops `DEPLOY_*` and `GITHUB_TOKEN`; a comment in `cd.yaml` says
  so, and `env:check` reports a stray that slips through as a key no schema reads.
- **The jq/masking caveat.** GitHub masks each registered secret value, but a value
  pulled out of `toJSON(secrets)` by jq is a derived string it does not auto-redact.
  So the assembly writes the file and never prints it; only the masked base64 leaves
  the step, and `docker compose logs` still prints container logs, not config
  (ADR 0014's "do not add a printer" holds). 
- **First deploy overwrites the box `.env` from the Environment**, so the Environment
  must be seeded from the current complete `.env` first (verify with `env:check`) or
  the app boots half-configured.
- **`toJSON(secrets)` including environment secrets** is the one behaviour the docs
  assert only indirectly (via the precedence order); the first deploy confirms it by
  logging the assembled **key names** (never values).
