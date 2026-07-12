# Secrets

This directory holds **two** secrets and only two: `postgres_password` and
`database_url`. They are Docker Compose `secrets:`, which are **files**, mounted
into the container at `/run/secrets/*`, never baked into an image and never
committed.

Every other secret (Discord bot token, TeamSpeak query password, session key,
the error-alert webhook) lives in the git-ignored `.env`, which Compose loads
into `web` and `worker` with `env_file:`. ADR 0014 is why. These two are here
because they were deployed here, and moving a live database credential buys
nothing.

The config package reads `X_FILE` for any variable `X`, which is how a mounted
file becomes `DATABASE_URL`. The mounted file **beats** an `X` set in the
environment, so the localhost `DATABASE_URL` in a developer's `.env` cannot
follow that same file into a container and shadow the real one. Local
development mounts nothing, so a plain `.env` works unchanged there.

To set this up:

```sh
cp secrets/postgres_password.example secrets/postgres_password
cp secrets/database_url.example secrets/database_url
# then edit both: the password must match the one inside the URL
```

Everything in this directory except the `.example` files and this README is
git-ignored.
