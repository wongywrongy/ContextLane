Signal redesign evidence, 2026-10-10. Captured from the production Vite build in real Chromium with deterministic API test responses from `tests/browser.mjs`; these are UI regression fixtures, not live host or deployment acceptance.

- `desktop.png`: Projects at 1440 × 1000.
- `tablet.png`: Projects at 1000 × 1000 (two columns, full-width Preview).
- `mobile.png`: Projects at 390 × 1000 (stacked summary panels; nav/search wrap).
- `expanded.png`, `tab-*.png`: Worktrees and the remaining detail tabs.
- `environment-logs.png`: recorded log response, including terminal text.
- `settings.png`, `mcp-desktop.png`, `mcp-mobile.png`: read-only Settings and MCP instructions.
- `unlock.png`, `unlock-mobile.png`: password entry with no shell chrome.
- `browser-results.json`: viewport/menu bounds, API requests, and browser exceptions (none).

The browser check covers initially collapsed details, panel breakpoints, long paths, search/⌘K, tabs, logs, stale/error responses, hidden unavailable lifecycle actions, refresh coalescing, connection loss/recovery, native popover Escape/focus restoration, visible keyboard focus and reduced motion. Fonts and both official agent marks are local assets, with provenance documented in `web/marks/README.md`.

Older subdirectories and `desktop-reference.png` retain historical review evidence and are not Signal screenshots.

After deployment, [live Signal captures](live-signal/README.md) separately verified the actual hosted backend at https://root.avlis.dev. The images in this directory remain deterministic regression fixtures.


2026-10-10, 0.3.0: root screenshots were refreshed from the production build with deterministic API fixtures. Proposal desktop/mobile captures show the unapproved warning, Copy, JSON and host steps; editor-fallback-mobile covers text/Copy and clipboard recovery. Browser checks additionally confirm original UUID reuse on retry and no readiness probes while collapsed. host-acceptance-results.json records real HTTP/systemd/Tailscale acceptance using isolated config/state and only the disposable fixture; it is separate from screenshot fixture data. live-signal captures were refreshed after the explicitly approved 0.3.0 deployment and show the actual hosted catalog and Settings, separately from fixture evidence.

Mobile refinement, 2026-10-10: `mobile-worktrees.png`, `mobile-agents.png`, `mobile-services.png`, `mobile-preview.png`, `mobile-environment.png` and `mobile-activity.png` capture the expanded phone surfaces, including their two-row tab navigation. `settings-mobile.png` and `mcp-tools-mobile.png` cover Settings and labeled MCP tool records. The browser regression records 41 responsive surface measurements in browser-results.json: 320/360/390/430/760/844 widths, no page/table overflow, every detail destination visible, mobile cell labels and controls at least 44px in both dimensions. Existing desktop/tablet, keyboard focus, Copy failure/recovery, reduced-motion and CSP checks remain. These are fixtures; hosted evidence is separate.
