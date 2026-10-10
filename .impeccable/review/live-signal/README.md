Live Signal deployment evidence, 2026-10-10, at https://root.avlis.dev. These captures use the actual authenticated hosted backend with certificate validation enabled; no intercepted API responses.

`desktop.png` is 1440 × 1000; `tablet.png` is 1000 × 1000; `mobile.png` is 390 × 1000. `expanded.png`, `settings.png` and `mcp.png` show the corresponding live surfaces at desktop size. `results.json` records card/panel counts, initially collapsed details, viewport overflow, font checks and browser exceptions.

Hosted owner login, real project catalog, three summary panels per card, local Geist fonts, all three responsive widths, details, Settings/MCP and no JavaScript exceptions passed. The HttpOnly session cookie stayed inaccessible to page JavaScript. Credentials were never captured or printed.

Image: rootlane:0.2.0-signal-20261010. Hosted asset hashes matched the workspace build. Configuration, credentials and Tailscale routes were preserved. Lifecycle actions, a second device and host reboot were not repeated.
