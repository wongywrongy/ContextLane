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
- **Each service** gets a free port in `$PORT` (and every service's port as `$PORT_<NAME>`), runs on 127.0.0.1, and gets its own link once it is healthy (see [Where services are reached](#where-services-are-reached)).
- **`database`** gives each lane its own scratch copy, created before setup and dropped on clean up. SQLite: `{ "kind": "sqlite", "file": "data/dev.db" }` copies the file, and services get its path in `DATABASE_PATH`. Postgres copies a template database, and services get a URL in `DATABASE_URL`. It needs two logins in `~/.config/contextlanes/config.toml`:

  ```toml
  [databases.postgres]
  admin = "postgres://contextlanes_admin:…@localhost/postgres"  # CREATEDB; never given to lanes
  app = "postgres://shop_app:…@localhost/postgres"               # what lane services connect as
  ```

  Once, as a superuser: `CREATE ROLE contextlanes_admin LOGIN CREATEDB PASSWORD '…'; GRANT shop_app TO contextlanes_admin;`. Each copy is owned by the app login, and tables the admin login owned in the template are handed to it. Nothing may be connected to the template while a copy is made.
- **Checks** run for every checkpoint; **screenshots** are taken before and after on those paths.
- Lane commands run in a sandbox that cannot see ContextLanes' data, its settings, Docker or the systemd user bus.

### In the Docker runtime

Lanes there are containers ([V4.md](V4.md) 3.4), and the recipe runs inside the lane's own container as the lane's user, in its checkout. What differs from the host:

- **Ports.** Every lane has its own network, so a service keeps one port in every lane: `"port": { "number": 5173 }`, or, left out, 3000 for the first service, 3001 for the next and so on (skipping numbers other services name). It still arrives in `$PORT` and `$PORT_<NAME>`. Two services cannot name the same number. On the host `number` is ignored and each lane gets free ports.
- **Address.** `$HOST` is `0.0.0.0`, and a service must listen on it: the router and health checks reach it as `cl-<project>-<NN>:<port>` over the private `contextlanes` network, never published. One that listens only on `127.0.0.1` cannot be reached, and `contextlanes app status` and `doctor` say so. Vite: `["npx", "vite", "--host", "$HOST", "--port", "$PORT"]`; Next.js: `["npx", "next", "dev", "-H", "$HOST", "-p", "$PORT"]`.
- **`copy`** works: a short-lived helper container that mounts your main checkout read-only and the lane's checkout copies the ignored files across, never over a file already there.
- **`cache`** and **`database`** are refused: the lane's image may not match the host's, and the lane cannot reach this machine's own database. Install dependencies in a setup step (`["npm", "ci"]`). A database belongs to the project's dev container (V4.md 3.4), but Compose-based `devcontainer.json` files are not supported in lanes yet; until they are, run the database inside the lane as another service, or point the app at one it can reach.
- There is no sandbox prefix: the container is the boundary. The recipe file must be a regular file (a symbolic link is not followed).

## Where services are reached

Every service's link is known before it starts, so it can be passed in:

| Variable | Holds |
|---|---|
| `LANE_URL`, `LANE_HOSTNAME` | This service's own link and hostname. In setup steps: the first service's. |
| `LANE_URL_<NAME>`, `LANE_HOSTNAME_<NAME>` | Every service's link and hostname, e.g. `LANE_URL_API` for a service called `api`. |
| `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` | This service's hostname, so Vite's dev server accepts it. |

They can be used in `command` arguments and in a service's `env` values, like `$PORT`:

```json
{ "name": "web", "command": ["pnpm", "dev", "--port=$PORT"], "env": { "VITE_API_URL": "$LANE_URL_API" } }
```

Without `[previews] domain` links are `http://<service>-<n>-<project>.localhost:4601`, which dev servers accept as they are. With a domain they are `https://<service>-<n>-<project>.<domain>`, and some dev servers refuse names they were not told about:

- **Vite:** nothing to do. The hostname arrives in `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`, and hot reload works through the router as long as your proxy passes WebSockets.
- **Next.js:** allow the name in `next.config.js`:

  ```js
  module.exports = {
    allowedDevOrigins: process.env.LANE_HOSTNAME ? [process.env.LANE_HOSTNAME] : [],
  };
  ```

- **Anything else** that checks the Host header (webpack-dev-server's `allowedHosts`, Django's `ALLOWED_HOSTS`, Rails' `config.hosts`): add `$LANE_HOSTNAME`. For CORS or API base URLs, use `$LANE_URL_<NAME>`.

In `serve` mode a link is chosen only once the service is healthy, so the `LANE_*` variables are not set.
