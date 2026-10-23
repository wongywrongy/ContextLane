# Project recipes

Commit `.rootlane.json` at each checkout root. Version 1 is strict: unknown fields, secret-like env keys, shell/env wrappers, escaping cwd paths, unknown placeholders and dependency cycles are rejected. Paths and commands are owner-reviewed code, not discovery permission. Rootlane passes the executable and argument array directly to `systemd-run`, with one `--setenv` argument per non-secret literal; application commands use no shell or env wrapper. Preparation uses a clean host environment through an internal env invocation. `setup` is displayed and never executed.

```json
{
  "version": 1,
  "services": [
    {"id":"api","cwd":"backend","command":["{venv}/bin/uvicorn","app.main:app","--host","127.0.0.1","--port","{port:api}"],"env":{"DATABASE_URL":"sqlite:///{state}/dev.db","CORS_ORIGINS":"{preview:console}"},"envFile":"~/.config/shuttleworks/dev.env","readiness":{"path":"/health","status":200,"bodyIncludes":"ok"}},
    {"id":"console","cwd":"frontend","command":["{node}","node_modules/vite/bin/vite.js","--host","127.0.0.1","--port","{port:console}"],"dependencies":["api"],"env":{"API_URL":"http://127.0.0.1:{port:api}"},"readiness":{"path":"/","status":200,"bodyIncludes":"<div id=\"root\">"}}
  ],
  "previews":[{"serviceId":"console","label":"Console"}],
  "setup":["make doctor"]
}
```

Host detection supplies Node/Python and checkout `.venv` paths when available. Owner config overrides detection with `toolchains: { "node":"/absolute/node", "python":"/absolute/python", "venvs": { "shuttleworks":"/absolute/.venv" } }` and `instancePorts: [20000,20999]`. Venv keys can also be the absolute Git common directory to disambiguate projects with the same name. Only used toolchains participate in approval revisions. Rerun deployment setup when mounting newly configured paths. Missing/unavailable toolchains give `TOOLCHAIN_MISSING` naming the key.

Rootlane resolves `{port:id}`, `{preview:id}`, `{state}`, `{node}`, `{python}`, `{venv}` and an initial `~` to the owner's home. It reserves both service and HTTPS ports in the same pool. Every service receives `ROOTLANE_PORT`, `ROOTLANE_PREVIEW_ORIGIN` and `ROOTLANE_PREVIEW_PORT`; preview variables are empty for services without their own preview. Private per-instance state survives Stop; Stop releases actual listeners and routes, while allocations remain reserved for a stable restart. Rootlane does not create databases. Informational `setup` hints remain inert; only separately reviewed structured `preparation` commands execute.

`env` contains non-secret literals only. Keys matching `SECRET|TOKEN|KEY|PASSWORD` must be in `envFile`. Avoid defining the same variable in both places: systemd gives the file precedence. Rootlane's reserved variables are forbidden in env files. Env files must be regular, owner-owned, exactly 0600 and outside observation roots; they are read at start and revalidated. In Docker, use a path in the owner's read-only home mount outside observation roots. Tool/UI output shows only variable names. Journal messages are redacted before truncation, including retained failure output. Redaction material is encrypted in private SQLite so restart logs remain redacted; an owner with the database and key can decrypt it. Rootlane's API is not a security boundary against the host owner or their application processes.

For Vite, configure once:

```ts
const origin = process.env.ROOTLANE_PREVIEW_ORIGIN;
export default defineConfig({
  server: {
    host: '127.0.0.1',
    strictPort: true,
    allowedHosts: origin ? [new URL(origin).hostname] : [],
    hmr: { clientPort: Number(process.env.ROOTLANE_PREVIEW_PORT) }
  }
});
```

The allowed host is the configured tailnet hostname, never `true` or `*`. Vite's client uses the browser's HTTPS connection; Rootlane's private Serve route forwards the HMR websocket. Use the allocated application port from the command or `ROOTLANE_PORT`. Install dependencies and run setup checks yourself before requesting Start.

Agent flow: `locate({path: cwd})` → `request_environment({path: cwd, requestId: UUID})` → if pending, share `approvalUrl` with the owner and poll `locate` → `start_environment({environmentId: resolvedPreview.instanceId, requestId: UUID})` → poll `get_environment`. Keep one UUID per action and reuse it unchanged on retries. Requesting is non-approving. The owner reviews and confirms in Projects using a cookie session and CSRF; the agent bearer token gets 403 on approval routes. `APPROVAL_REQUIRED` includes the approval URL. Rejected recipes require a new revision for a new request.

Approval binds the Git common directory, recipe SHA256 and used toolchain revision; main and other worktrees can reuse the same approved recipe while receiving independent instances, ports and previews. Changing the recipe or a used configured/resolved toolchain path makes that checkout stale. Stop still works from recorded ownership after the recipe is removed or changed. Existing resource revision guards require Stop before replacing a running instance. Config-file profiles remain available for non-repo setups.

## Convert shuttleworks-dev

1. On the owner host, inspect the existing `shuttleworks-dev` profile and move its direct API/frontend commands and readiness into the project's `.rootlane.json`. Review actual cwd, module paths and readiness bodies; the example above is illustrative.
2. Move secret exports from `/usr/bin/env` or shell commands to `~/.config/shuttleworks/dev.env`, owned by the installation owner, mode 0600, outside observation roots. Set the Node/Python/venv map in private host config and rerun setup for mounts.
3. Configure Vite HMR and allowedHosts as above; commit the recipe. Request an environment and have the owner review it.
4. Stop the old Rootlane-owned profile before starting the recipe instance. Validate Ready and Available, then remove `shuttleworks-dev` from private config and run `rootlane-reload`.

`get_capabilities` emits `IMPLICIT_ENV_WRAPPER` for legacy shell/env profiles. Rootlane does not rewrite the ShuttleWorks repository or private configuration as part of this migration.

Migration 003 preserves existing requests, resource reservations and ownership. Back up SQLite before installing 0.4.0; downgrading to a build that supports only migration 002 requires restoring that backup, not opening the migrated database with the old image.

Services load private `envFile` values through systemd's `EnvironmentFile=`
property. Rootlane validates ownership, mode 0600 and location outside observation
roots, reads values at launch for redaction, and passes only the absolute file path
to systemd. `--setenv` carries non-secret literals and Rootlane's preview settings.
`systemctl --user show -p Environment` therefore shows only those literals;
`EnvironmentFiles` shows the file path. Use the same simple `NAME=value` syntax
supported by Node's env-file parser and systemd (no shell expansion). Do not define
the same variable in both `env` and `envFile`: systemd gives the file precedence.
Keep `ROOTLANE_` names out of envFile.

## Host-local configuration and preparation

**Configure environment** reads bounded metadata without importing application code. The initial proposal supports plain `vite` dev scripts, simple npm workspace patterns (`apps/*`, `packages/*` or explicit directories), and a unique static FastAPI assignment in `main.py`, `app.py`, `app/main.py` or `src/main.py`. FastAPI requires declared Uvicorn dependencies; generated previews open `/docs`. Custom dev launchers, complex workspace globs, conflicting lockfiles and ambiguous Python objects need manual recipe review. Node inspection uses at most 64 bounded file reads; manifest fingerprints cap individual files at 1 MiB and total contents at 4 MiB. Oversized/unreadable files block preparation.

Generated recipes and checkout runtime overrides are stored in private SQLite, labelled **Host-local**. An existing `.rootlane.json`, labelled **Project-shared**, always takes precedence, including when invalid. Export downloads JSON for a normal repository review; Rootlane does not silently write it into the checkout.

Optional version-1 fields:

```json
{
  "version": 1,
  "restart": "on-failure",
  "services": [{
    "id": "web", "cwd": ".",
    "command": ["{node}", "{vite-launcher}"],
    "requiredEnv": ["API_URL"],
    "envFile": "{state}/environment.env",
    "readiness": {"path": "/", "status": 200, "bodyIncludes": "<"}
  }],
  "previews": [{"serviceId": "web", "label": "Web", "path": "/"}],
  "preparation": [{
    "command": ["/absolute/path/to/npm", "ci"], "cwd": ".",
    "writes": ["node_modules"], "lifecycleScripts": true, "timeoutMs": 300000
  }],
  "setup": ["Optional informational hints remain here"]
}
```

`requiredEnv` declares names, never values. The UI reports every missing name and its private file location. Keep owner-owned mode-0600 files outside observation roots. Rootlane passes the file path to systemd and redacts retained application logs.

Preparation review shows exact argument arrays, canonical working directories, expected writes, whether install/build lifecycle scripts may execute, time bounds, resolved tools and manifest/lockfile digests. The owner must approve that fingerprint through a cookie/CSRF session. An agent can inspect or request a configuration review but cannot approve preparation. Installation jobs receive only HOME and PATH, without inherited application environment values. Jobs run through the host’s user systemd manager, so project mounts remain read-only in Docker. Each job is recorded and bounded; controller restart requires an interrupted preparation to be reviewed again. Journals stay on the host; returned errors contain bounded diagnostics without application secret values.

Changed manifests or lockfiles invalidate preparation and configuration approval. Preparation may create a reviewed lockfile, after which request a fresh configuration review. An unchanged successful preparation is reused.

The `{vite-launcher}` is a reviewed Rootlane script written into private state, then executed by the host Node interpreter. It loads the project’s Vite configuration, fixes loopback binding and strict ports, and supplies the exact tailnet hostname and HTTPS WebSocket settings. Its source participates in toolchain approval. Custom launch scripts receive remediation instead of source edits. See [Vite server options](https://vite.dev/config/server-options).

`restart` is optional. Omitted or `no` preserves manual restart behavior. Generated configurations choose `on-failure`: a two-second delay and a three-start budget per 60 seconds, including the initial start. Systemd exposes attempts, exit status and limit exhaustion; Rootlane does not run a second crash supervisor. Reboot restoration is a separate owner choice, off by default. See [systemd restart](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) and [start limits](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html).
