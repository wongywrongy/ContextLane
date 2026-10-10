# Project recipes

Commit `.rootlane.json` at each checkout root. Version 1 is strict: unknown fields, secret-like env keys, shell/env wrappers, escaping cwd paths, unknown placeholders and dependency cycles are rejected. Paths and commands are owner-reviewed code, not discovery permission. Rootlane passes the executable and argument array directly to `systemd-run`, with one `--setenv` argument per non-secret literal; it never invokes a shell or `/usr/bin/env`. `setup` is displayed and never executed.

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

Owner config supplies `toolchains: { "node":"/absolute/node", "python":"/absolute/python", "venvs": { "shuttleworks":"/absolute/.venv" } }` and `instancePorts: [20000,20999]`. Venv keys can also be the absolute Git common directory to disambiguate projects with the same name. Only used toolchains participate in approval revisions. Rerun deployment setup when mounting newly configured paths. Missing/unavailable toolchains give `TOOLCHAIN_MISSING` naming the key.

Rootlane resolves `{port:id}`, `{preview:id}`, `{state}`, `{node}`, `{python}`, `{venv}` and an initial `~` to the owner's home. It reserves both service and HTTPS ports in the same pool. Every service receives `ROOTLANE_PORT`, `ROOTLANE_PREVIEW_ORIGIN` and `ROOTLANE_PREVIEW_PORT`; preview variables are empty for services without their own preview. Private per-instance state survives Stop; Stop releases actual listeners and routes, while allocations remain reserved for a stable restart. Rootlane does not create databases or execute setup steps.

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
