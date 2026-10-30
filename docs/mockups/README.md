# Mockups

Exported from the design canvas (page v4, "Full site"). These are the reference for every screen. The web app ports the canvas CSS into `apps/web/src/styles/app.css` with the same class names (`.sec`, `.wk3`, `.lrow`, `.st3`, `.compose`, `.tile`, `.need`, `.irow`, `.sst` …), so a board and its page can be compared side by side.

When a page and its board disagree, the board wins unless the data does not exist yet. In that case leave the element out (or behind a flag in `apps/web/src/features.ts`); never fill it with invented numbers.

| Board | Route | Code | Built |
|---|---|---|---|
| [projects.webp](projects.webp) | `/` | `pages/Projects.tsx`, `components/AddRepo.tsx` | Yes. The usage line in the header shows only measured limits and GPU load; missing ones are left out |
| [work-lane.webp](work-lane.webp) | `/p/:project/work?lane=` | `pages/project/Work.tsx`, `work/Steps.tsx`, `work/Composer.tsx`, `work/Inspector.tsx` | Yes, including Watching only / Take over, @ file, / command, pictures, hand off, fork and fresh session. The inspector has three more lane actions than the board (Open terminal, Copy command, Copy branch) |
| [work-overview.webp](work-overview.webp) | `/p/:project/work` | `work/Overview.tsx` | Yes. Lane nodes have no "now" sub-row; the graph keeps zoom controls; the legends are sentences, not line samples |
| [inbox.webp](inbox.webp) | `/inbox` | `pages/Inbox.tsx` | Yes. Filter chips show only when there are two kinds of item |
| [setup.webp](setup.webp) | `/setup` | `pages/Setup.tsx`, `setup/Agents.tsx` | Yes, with one step the board lacks: 4 Get to know your projects (CodeGraph map, recipe state, services and agent sessions already running outside a lane) before the first lane, which can be skipped. The terminal block shows `contextlanes setup`; agents use Ready / Install / Sign in instead of toggles; no "everything is a file" section |
| [settings.webp](settings.webp) | `/settings` | `pages/Settings.tsx` | Yes, plus Projects and Scheduled lanes sections. Notification channels open as forms rather than toggles; Lanes is a number field; history retention is not built |
| [models.webp](models.webp) | `/models` | `pages/Settings.tsx` (`ModelsPage`) | Yes: agents, reported limits, local models, local helper and routing. Agents are the shared Setup rows (no mode dropdown or per-agent lane count); Add endpoint and Add rule are rows that open forms |
| [review.webp](review.webp) | `/p/:project/review` | `pages/project/Review.tsx` | Yes, including test counts, changed-area highlights, "Shares a file with" and Ask another agent to review |
| [run.webp](run.webp) | `/p/:project/run` | `pages/project/Run.tsx` | Yes, including the lane's database |
| [architecture.webp](architecture.webp) | `/p/:project/architecture` | `pages/project/Architecture.tsx` | Yes. Large repositories (over 16 modules) open on an area grid the board does not show, then the board's layer columns inside an area; plus Find a module and Grouping (local-model tidy). Dashed "added by a lane" edges are not drawn; Main paths shows only when CodeGraph finds routes |
| [insights.webp](insights.webp) | `/p/:project/insights` | `pages/project/Insights.tsx` | Yes, plus Skills under "What every lane starts with". The context breakdown by rules, tools, files and conversation is left out: agents do not report it |
| [phone-lane.webp](phone-lane.webp) | same route at 390px | same files | An open lane fills the screen with a back link and a pinned message box. The inspector stays below the steps rather than being dropped, so phone keeps hand off, fork and terminal |
| [phone-inbox.webp](phone-inbox.webp) | same route at 390px | same files | The board's bottom tab bar is not built; the top bar wraps to two rows (DESIGN.md rule 5) |
| [legend.webp](legend.webp) | — | `components/ui.tsx` (`GLYPH`, `Tile`, `AgentMark`, `LaneBadge`) | Yes |

Checked against every board at 1440px and 390px on 2026-10-30 (4.7), with a seeded fixture and Chromium. No page scrolls sideways at either width.

To re-export after the canvas changes, render each board at 1440px (390px for phone boards) and save as WebP.
