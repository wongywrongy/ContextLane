Live Signal deployment evidence, 2026-10-10, at https://root.avlis.dev. These captures use the actual authenticated hosted backend with certificate validation enabled; no intercepted API responses.

`desktop.png` is 1440 × 1000; `tablet.png` is 1000 × 1000; `mobile.png` is 390 × 1000. `expanded.png`, `settings.png` and `mcp.png` show the corresponding live surfaces at desktop size. `results.json` records card/panel counts, initially collapsed details, viewport overflow, font checks and browser exceptions.

Hosted owner login, real project catalog, three summary panels per card, local Geist fonts, all three responsive widths, details, Settings/MCP and no JavaScript exceptions passed. The HttpOnly session cookie stayed inaccessible to page JavaScript. Credentials were never captured or printed.

Image: rootlane:0.3.0. Hosted asset hashes matched the workspace build. Configuration, credentials and Tailscale routes were preserved. Installed lifecycle actions were not repeated during deployment; isolated real HTTP fixture acceptance is recorded separately in `../host-acceptance-results.json`. Second-device preview/HMR, reboot and SSH disconnect remain owner checks.

Mobile refinement captures were refreshed after deployment: 44px controls, two-column phone filters, wrapped paths and preview links, agent metadata below names, and labeled detail/MCP records. The deterministic review captures include every mobile detail tab; live captures use the actual hosted catalog. Physical-device and Safari/Firefox testing remain unclaimed.

0.4.0 deployment verification, 2026-10-10: refreshed these captures against the actual hosted backend after the owner-approved recipe upgrade. HTTPS login, real catalog and summaries, local fonts, desktop/tablet/phone bounds, details, Settings/MCP and zero browser exceptions passed. MCP discovery/calls independently confirmed thirteen tools in both protocol eras. No recipe approval or application mutation was manufactured for screenshot evidence; ShuttleWorks remains on its existing configuration. Migration and backup evidence is in `deployment-040.json` and VERIFICATION.md.
