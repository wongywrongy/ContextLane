Signal redesign evidence, 2026-10-10. Captured from the production Vite build in real Chromium with deterministic API test responses from `tests/browser.mjs`; these are UI regression fixtures, not live host or deployment acceptance.

- `desktop.png`: Projects at 1440 × 1000.
- `tablet.png`: Projects at 1000 × 1000 (two columns, full-width Preview).
- `mobile.png`: Projects at 390 × 1000 (stacked summary panels; nav/search wrap).
- `expanded.png`, `tab-*.png`: Worktrees and the remaining detail tabs.
- `environment-logs.png`: recorded log response, including terminal text.
- `settings.png`, `mcp-desktop.png`, `mcp-mobile.png`: read-only Settings and MCP instructions.
- `unlock.png`, `unlock-mobile.png`: password entry with no shell chrome.
- `browser-results.json`: viewport/menu bounds, API requests, and browser exceptions (none).

The browser check covers initially collapsed details, panel breakpoints, long paths, search/⌘K, tabs, logs, stale/error responses, hidden unavailable lifecycle actions, refresh coalescing, connection loss/recovery, native popover Escape/focus restoration, visible keyboard focus and reduced motion. Fonts and the Claude mark are local assets. Codex retains CX initials as documented in `web/marks/README.md`.

Older subdirectories and `desktop-reference.png` retain historical review evidence and are not Signal screenshots.

After deployment, [live Signal captures](live-signal/README.md) separately verified the actual hosted backend at https://root.avlis.dev. The images in this directory remain deterministic regression fixtures.
