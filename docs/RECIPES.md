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

- **Ignored `.env*` files** are copied from your main checkout by the recipe's copy patterns; `cache` folders are copied into the lane without sharing writable file contents with the source. Include only development credentials intended for the lane.
- **Each service** gets a free port in `$PORT` (and every service's port as `$PORT_<NAME>`), runs as its own systemd unit on 127.0.0.1, and gets a private link on your tailnet.
- **`database`** gives each lane its own scratch copy, created before setup and dropped on clean up. SQLite: `{ "kind": "sqlite", "file": "data/dev.db" }` copies the file, and services get its path in `DATABASE_PATH`. Postgres copies a template database, and services get a URL in `DATABASE_URL`. It needs two logins in `~/.config/contextlanes/config.toml`:

  ```toml
  [databases.postgres]
  admin = "postgres://contextlanes_admin:…@localhost/postgres"  # CREATEDB; never given to lanes
  app = "postgres://shop_app:…@localhost/postgres"               # what lane services connect as
  ```

  Once, as a superuser: `CREATE ROLE contextlanes_admin LOGIN CREATEDB PASSWORD '…'; GRANT shop_app TO contextlanes_admin;`. Each copy is owned by the app login, and tables the admin login owned in the template are handed to it. Nothing may be connected to the template while a copy is made.
- **Checks** run when a checkpoint is requested, after the target base is integrated. They run in a disposable worktree of the exact commit, with copied dependencies, recipe setup and a separate database. They must pass before review can proceed. Failures return to the agent for up to two repair turns, then create an Inbox question; owner guidance resets that budget. A changed live commit or recipe needs fresh evidence.
- **Generated source** must be committed before checks. Setup/check commands that modify tracked source in the snapshot invalidate it. Keep transient build output ignored, and make setup sufficient to recreate dependencies and migrations from the committed checkout.
- **Screenshots** are taken before and after on the configured paths; the before image uses a separate disposable worktree and database.
- Lane commands use the filesystem restrictions described in [Architecture](ARCHITECTURE.md#trust-boundaries). They retain the host network; authenticated local services and lane-specific development credentials remain important.
