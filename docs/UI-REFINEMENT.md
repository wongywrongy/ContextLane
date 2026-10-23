# Interface audit and refinement — 2026-10-23

The review used fresh authenticated captures of the running site, rather than the old artboards. Scope: project list and densities, overview, logs, services/links, agents and session details, worktrees, activity, connection settings, MCP inspection/repair, telemetry/setup and unlock. There were 29 before captures at 1440px and 390px; responsive fixtures additionally exercise 360, 768, 1100 and 1920px.

Applied guidance: Impeccable audit, quieter, distill and animate; Taste app screens; Emil Kowalski design engineering, animation recipes and motion audit. Taste's sampled neutral direction used seed 1746727176. Its stock sidebar was adapted to the existing two-destination top navigation, preserving the established navigation model. Geist was retained to avoid adding a font dependency for this refinement.

## Findings and changes

| Priority | Before | After | Why |
| --- | --- | --- | --- |
| P1 | Scan diagnostics and a large port inventory appeared above every project. The first phone row began at 648px. | A notices control opens bounded diagnostics; phone header and empty rows are compact. | Keep the workspace about the projects. |
| P1 | Muted text was around 3.7–3.8:1 and the gradient action reached only about 4:1. | Shared readable neutral text tokens and a light solid primary action. | Supporting information and actions need readable contrast. |
| P1 | A menu click opened both the menu and details. Search could navigate projects and move focus out of the phone modal. Disabled menu actions trapped arrow navigation. | Each gesture affects one surface. Modifier keys are excluded from panel navigation; phone search closes the modal first; menu arrows skip disabled actions. | Predictable keyboard and pointer behavior. |
| P1 | Inspect and destructive telemetry purging were neighboring actions. | Purging has its own maintenance disclosure and retains confirmation. | Separate routine setup from deletion. |
| P2 | Paths, control IDs, service observations and recovery explanations repeated in the environment controls. | A checkout summary, visible errors/actions and expandable configuration/options. | Reduce repeated information while retaining ownership and approval evidence. |
| P2 | Full client snippets, repair JSON and all 19 tool descriptions formed a long settings document. | Status first; individually expandable repair, client details, tool reference and setup steps. | Make routine checks quick and exact configuration review available. |
| P2 | Narrow desktop tables squeezed paths and even the Copy label into vertical fragments. | Container-based table layout wraps fields according to panel width. | Desktop panels need the same attention as phone layouts. |
| P2 | Grids, glow, translucent chrome and several control styles competed with state. | Flat neutral surfaces, one control rhythm, shared typography and spacing. | Give real data and the next action the visual emphasis. |
| P2 | Several phone controls were 30–34px. | Primary controls and links have 44px phone targets. | Make common actions easier to use. |
| P3 | Feedback timing and repeated interactions lacked a common rule. | Shared 140ms color feedback, immediate tabs/keyboard updates and reduced-motion support. | Frequent controls should feel responsive without unnecessary movement. |

## Assessment

Scores describe the captured interface, from 0 (blocking) to 4 (strong), rather than certification: accessibility 2 → 3; theming/consistency 1 → 3; responsive behavior 2 → 3; interface integrity 2 → 3. Performance was not profiled for a numerical score. Decorative blur and gradients were removed; no dependency was added.

The authenticated detector found no contrast, overflow or decorative-background issues in the refined project, detail and settings views. Its remaining font-popularity warning reflects the intentional reuse of the installed Geist family. This is a heuristic result, supported by visual review, not a WCAG certification.

## Verification

- Typecheck, production build and all 188 tests pass with Node 24.22.1. Tests needing local listeners run with host access.
- Responsive Chromium fixtures cover all services and links in both densities, every detail tab, navigation/history, keyboard/focus, logs, errors/retry, MCP repair, guarded credential copy, preparation review/cleanup and checkout selection.
- Fresh authenticated captures use actual host data; local frontend preview replaces only static assets. Auditing does not start or stop managed environments.
- Browser regressions cover the reproduced menu and search bugs. Reduced motion and expanded setup/reference states are checked separately.

Physical devices, Safari and screen-reader certification are outside this verification. Application startup failures belong to their projects and remain visible; this interface change does not repair other applications.
