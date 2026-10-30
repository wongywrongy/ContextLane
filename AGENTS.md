# Working in this repo

ContextLanes runs several coding agents in parallel lanes on an always-on machine. This branch is a fresh start; the old Rootlane code is gone.

Read first: [docs/BRIEF.md](docs/BRIEF.md) (what and why), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it fits together), [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md) (what to build next, phase by phase), [docs/DESIGN.md](docs/DESIGN.md) (visual system and page jobs).

## Commands

```sh
pnpm install          # Node >= 22.13 (24 recommended), pnpm 10
pnpm check            # typecheck + tests + build; must pass before every commit
pnpm test             # Vitest across all packages, no build needed
pnpm dev              # daemon on :4600 and the web app with /api proxied
```

## Layout

| Path | What |
|---|---|
| `packages/protocol` | Shared types: ids, lane lifecycle, events, API. Change it first when a feature needs new data |
| `packages/toolbox` | MCP tools each agent gets |
| `apps/daemon` | HTTP API, SQLite event log, lane manager, lane-host socket, live stream |
| `apps/lanehost` | One process per lane holding the agent's ACP session |
| `apps/cli` | The `contextlanes` command |
| `apps/web` | React + Vite UI |

## Rules

- **Everything is an event.** Write through `Store.appendEvent` or `Store.setLaneState`; never update lane state without the matching event.
- **Validate at the edge.** Request bodies and event payloads go through the zod schemas in `packages/protocol`.
- **No shell strings.** Run commands through the injected `Runner` with argument arrays, so tests can fake git, tmux and systemd.
- **Agents never approve.** Only `/api/answers` resolves a permission. Never add auto-allow timers.
- **Loopback only, credentials always.** The daemon binds `127.0.0.1`, so every request looks local. Only a token says who is asking (`apps/daemon/src/http/auth.ts`); never trust an address or header.
- **Lane commands run in the sandbox.** Anything started for a lane goes through `sandbox()` (`apps/daemon/src/sandbox.ts`). The daemon's own git and gh go through `confineGit`; never build a runner for them without it.
- **UI:** match the board in `docs/mockups/` for the page you touch, using the classes already in `apps/web/src/styles/app.css`; do not invent new layouts. Every group of content in a section; one main column per page; side column only as an inspector; state is a glyph plus a word, never colour alone. Copy is plain and specific.
- **Show only what works.** Hide a tab, block or action until its phase works (`apps/web/src/features.ts`); give agents only working tools (`LIVE_TOOLS`). No placeholder numbers.
- **Tests with every change:** unit tests next to the package in `test/`; API tests through `fastify.inject`.
- **ESM, strict TypeScript, `.js` extensions in Node imports**, no default exports except React pages.
- Keep dependencies few and pinned to exact versions.
