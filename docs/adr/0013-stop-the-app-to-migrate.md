# The deploy stops the app to migrate, and dumps the database first

The deploy sequence is now: pull, **dump**, **stop `web` and `worker`**, migrate, `up`. Two additions to ADR 0012's "pull, migrate, up", and they buy the same thing from two directions: a migration can no longer half-break production, and a migration that was simply wrong can be undone.

Migrations therefore do **not** have to be backward-compatible with the previous release. A `DROP COLUMN` may ship in the same deploy as the code that stops reading it.

## Why

`docker compose --profile migrate run --rm migrate` starts the migrate container and Postgres. It does not touch `web` or `worker`, which keep running the *previous* release throughout, and keep running it until `up` recreates them and `--wait` clears their healthchecks up to a minute and a half later. So the old code was serving traffic against a schema it was never written for, on every deploy, for a window we did not choose and did not measure.

For an additive migration that is harmless, and most will be. For a `DROP COLUMN` or a rename it is not: Drizzle emits explicit column lists, so the still-serving old release takes a `42703` on every affected query for the length of the window. Worse, the *migration itself* is exposed to the old release: DDL needs an `ACCESS EXCLUSIVE` lock, and if one of the old worker's connections is sitting idle in a transaction, the `ALTER TABLE` blocks. Postgres's lock queue is FIFO, so every subsequent query against that table then queues behind the blocked DDL, and a table that nobody could write becomes a table nobody can read either.

There are exactly two ways out. **Expand/contract**: a standing rule that every migration is backward-compatible with the release before it, so a drop is always a separate, later deploy. It is the professional answer and it costs a permanent discipline, applied by one person, in spare time, on a schema that changes a handful of times a year. **Or stop the app**: take the site down for the length of the migration.

The unit is about a hundred people whose operations are Saturday evening. The site is a handbook and a roster. Nobody is reading it at deploy time, and if they are, they can read it ninety seconds later. Downtime here is genuinely free, and buying it deletes the entire class of problem rather than managing it: no window, no lock contention with the old release, no rule to remember at 1am eighteen months from now when the schema needs a column dropped.

The dump exists because the other half of the problem is not concurrency at all. There are no down migrations, and rolling the images back restores the old code *against the new schema*, which is not a rollback. A migration that fails is safe, because Drizzle runs the whole batch in one transaction (ADR 0008) and it rolls back. A migration that **succeeds at doing the wrong thing** was, until now, permanent. ADR 0011 saw this coming and said so in its closing line: "The realistic disaster is not losing the disk, it is a bad migration dropping a table." It asked for a same-box `pg_dump` and nobody built one. This builds it.

## Considered and rejected

- **Expand/contract.** The correct answer for a system with users at 3am, an on-call rotation, and more than one person who might write a migration. This project has none of those. Rejected as buying, at a permanent cost in discipline, something that ninety seconds of downtime gives away.
- **Blue/green or a rolling deploy.** Solves the window properly and needs a second stack and a proxy that can switch between them. ADR 0005 puts infrastructure out of scope, and this would drag it back in for a handbook.
- **`docker compose down` instead of stopping two services.** Would take Postgres down too, which is what the migrator needs to be up.
- **Backing the dump off-box.** Explicitly out of scope: ADR 0011 weighed that and rejected it, and nothing here reopens it. This is a dump to a folder on the same box, which protects against the *likely* failure (a bad migration) and not the unlikely one (losing the box). It is not a backup and does not claim to be.
- **Restoring automatically when a migration fails.** A failed migration already rolls back on its own. An automatic restore would only ever fire on a migration that *succeeded*, which is a decision no script should make.

## Consequences

- **Every deploy has a short outage**, roughly the length of the migration plus the healthcheck start period. On a no-op migration that is seconds. Accept it; do not optimise it.
- **`web` and `worker` are stopped, not removed**, so `docker compose stop` on a box where they do not exist yet exits 0 and a first deploy on a fresh directory is unaffected.
- **Migrations may be destructive.** This is the point. The constraint that would otherwise apply (never drop in the same deploy as the code change) does not.
- **The dumps are member PII** (Discord, TeamSpeak, Steam ids). `backups/` is git-ignored, and the deploy keeps the last 10. This is the same reasoning that made ADR 0011 refuse to put dumps in a git repository, so do not undo it by mailing one to yourself.
- **Restoring is a manual, deliberate act**, which is correct, because deciding that a *successful* migration was wrong is a judgement call:
  ```
  docker compose exec -T postgres pg_restore -U 7r -d 7r --clean --if-exists /backups/<file>
  ```
- **The migrator sets `lock_timeout` (5s) and `statement_timeout` (5m).** Stopping the app removes the expected lock contention, but not every one: a stray `psql`, a leftover session, a manual query. The timeout turns what would be a thirty-minute wedge (bounded only by the SSH step's own timeout) into a clean failure that rolls back and reddens the deploy.
- **This does not narrow ADR 0005 further.** The deploy learns nothing new about the host. It already knew the shell and `DEPLOY_PATH`; it now also stops two of its own containers and writes a file into its own bind mount.
