# Recipes

A lane runs your app from `.contextlanes.json` at the repository root. Nothing in it runs until you approve its exact contents on the Run page, and an agent that edits it needs approval again. Commands are argument lists, never shell strings.

```json
{
  "cache": ["node_modules"],
  "database": { "kind": "postgres", "template": "shop_dev" },
  "setup": [{ "name": "Migrate", "command": ["pnpm", "migrate"] }],
  "services": [
    { "name": "api", "command": ["pnpm", "dev:api", "--port", "$PORT"], "health": { "path": "/health" } },
    { "name": "web", "command": ["pnpm", "dev:web", "--port=$PORT"] }
  ],
  "checks": [{ "name": "Tests", "command": ["pnpm", "test"] }],
  "screenshots": ["/"]
}
```

- **Ignored `.env*` files** are copied from your main checkout; `cache` folders are hard-linked.
- **Each service** gets a free port in `$PORT` (and every service's port as `$PORT_<NAME>`), runs as its own systemd unit on 127.0.0.1, and gets a private link on your tailnet.
- **`database`** gives each lane its own scratch copy, created before setup and dropped on clean up. SQLite: `{ "kind": "sqlite", "file": "data/dev.db" }` copies the file, and services get its path in `DATABASE_PATH`. Postgres copies a template database, and services get a URL in `DATABASE_URL`. It needs two logins in `~/.config/contextlanes/config.toml`:

  ```toml
  [databases.postgres]
  admin = "postgres://contextlanes_admin:…@localhost/postgres"  # CREATEDB; never given to lanes
  app = "postgres://shop_app:…@localhost/postgres"               # what lane services connect as
  ```

  Once, as a superuser: `CREATE ROLE contextlanes_admin LOGIN CREATEDB PASSWORD '…'; GRANT shop_app TO contextlanes_admin;`. Each copy is owned by the app login, and tables the admin login owned in the template are handed to it. Nothing may be connected to the template while a copy is made.
- **Checks** run for every checkpoint; **screenshots** are taken before and after on those paths.
- Lane commands run in a sandbox that cannot see ContextLanes' data, its settings, Docker or the systemd user bus.
