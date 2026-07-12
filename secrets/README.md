# Secrets

Docker Compose `secrets:` are **files**, mounted into the container at
`/run/secrets/*`. They are never baked into an image and never committed
(IMPLEMENTATION.md §2).

The config package reads `X_FILE` for any variable `X`, which is how a mounted
file becomes `DATABASE_URL`. A directly-set `X` still wins, so a plain `.env`
works unchanged in local development.

To set this up:

```sh
cp secrets/postgres_password.example secrets/postgres_password
cp secrets/database_url.example secrets/database_url
# then edit both: the password must match the one inside the URL
```

Everything in this directory except the `.example` files and this README is
git-ignored.
