# Working in this repo

ContextLanes is a lane runtime on an always-on machine: each lane is a worktree, a tmux terminal, a running copy of the app and a link per service. Agents run as their own CLIs and use lanes through the `contextlanes` command.

Read first: [docs/V3.md](docs/V3.md) (what it is now and why), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it fits together), [docs/PROXY.md](docs/PROXY.md) (how links reach a browser), [docs/DESIGN.md](docs/DESIGN.md) (visual system and page jobs). [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) records what was built and what still needs the owner.

## Commands

```sh
pnpm install          # Node >= 22.13 (24 recommended), pnpm 10
pnpm check            # build + typecheck + tests; must pass before every commit
pnpm test             # Vitest across all packages, no build needed
pnpm dev              # daemon on :4600 and the web app with /api proxied
```

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Shared types: ids, lane lifecycle, events, API. Change it first when a feature needs new data |
| `packages/toolbox` | MCP tools each agent gets (the CLI calls the same routes) |
| `apps/daemon` | HTTP API, SQLite event log, lane manager, runtime, preview router (`preview-router.ts`, `previews.ts`), supervisors (`supervisor/`), feature flags (`features.ts`), doctor |
| `apps/lanehost` | One process per ACP lane holding the agent's ACP session (`[features] acp`) |
| `apps/cli` | The `contextlanes` command |
| `apps/web` | React + Vite UI |

## Rules

- **Everything is an event.** Write through `Store.appendEvent` or `Store.setLaneState`; never update lane state without the matching event.
- **Validate at the edge.** Request bodies and event payloads go through the zod schemas in `packages/protocol`.
- **No shell strings.** Run commands through the injected `Runner` with argument arrays, so tests can fake git, tmux and systemd.
- **Lane checkouts are agent-controlled.** The daemon runs outside the sandbox, so it reads, copies and writes files in a lane checkout only through `apps/daemon/src/safefs.ts` (no following symlinks out, no FIFOs or devices).
- **Agents never approve.** A permission is resolved by the owner through `/api/answers`, or, in a lane the owner put in Auto, by ContextLanes through `permissions.ts` using the fixed rules in `packages/protocol/src/guard.ts` (dire actions always wait for the owner; only "allow once" is ever chosen). Never let an agent, its prompt or its tools turn Auto on or widen the guard, and never add auto-allow timers.
- **Loopback only, credentials always.** The API binds `127.0.0.1`, so every request looks local. Only a token says who is asking (`apps/daemon/src/http/auth.ts`); never trust an address or header. The preview router is the one listener that may bind elsewhere (`[previews] bind`); it passes `Host` through unchanged and answers only names it published.
- **Host-specific commands go through a driver.** Lane services, recipe one-shots, the sandbox proof and lane terminals go through `supervisorFor(config, run)` (`apps/daemon/src/supervisor/`), never `systemd-run` or `systemctl` directly; both drivers must pass `test/supervisor.contract.test.ts`. Only what is systemd-only by nature (ACP lane hosts, schedules, install, update) calls systemd itself, and it refuses with `needs_systemd` under the process driver. A driver is added only with a second real implementation to test it against.
- **The sandbox can be off, never silently.** `sandbox()` returns an empty prefix when `[sandbox] mode = "off"`; build argv as `[...sandbox(config), ...command]` (or `inSandbox`), never index the prefix. Nothing may turn it off but the owner's config.
- **Lane commands run in the sandbox.** Anything started for a lane goes through `sandbox()` (`apps/daemon/src/sandbox.ts`). The daemon's own git and gh go through `confineGit`; never build a runner for them without it.
- **UI:** match the board in `docs/mockups/` for the page you touch, using the classes already in `apps/web/src/styles/app.css`; do not invent new layouts. Every group of content in a section; one main column per page; side column only as an inspector; state is a glyph plus a word, never colour alone. Copy is plain and specific.
- **Show only what works.** Anything outside the core gets a `[features]` flag (`packages/protocol/src/features.ts`): its routes go in `apps/daemon/src/features.ts`, its workers start only when it is on, its tools are filtered by `laneTools`, and the web app hides it through `useFeatures()`. Give agents only working tools (`LIVE_TOOLS`). No placeholder numbers.
- **The CLI is an interface for agents.** Every command takes `--json` and then prints one JSON document on stdout; errors go to stderr; exit 0 done, 1 failed, 2 usage, 3 unreachable, 4 waiting on the owner. Keep `AGENT_NOTES` (`packages/protocol/src/agent-notes.ts`) and the README block identical; a test checks it.
- **Tests with every change:** unit tests next to the package in `test/`; API tests through `fastify.inject`.
- **ESM, strict TypeScript, `.js` extensions in Node imports**, no default exports except React pages.
- Keep dependencies few and pinned to exact versions.
