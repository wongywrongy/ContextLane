# Mockups

Exported from the design canvas (page v4, "Full site"). These are the reference for every screen. The web app ports the canvas CSS into `apps/web/src/styles/app.css` with the same class names (`.sec`, `.wk3`, `.lrow`, `.st3`, `.compose`, `.tile`, `.need`, `.irow`, `.sst` …), so a board and its page can be compared side by side.

When a page and its board disagree, the board wins unless the data does not exist yet. In that case leave the element out (or behind a flag in `apps/web/src/features.ts`); never fill it with invented numbers.

| Board | Route | Code | Built |
|---|---|---|---|
| [projects.webp](projects.webp) | `/` | `pages/Projects.tsx`, `components/AddRepo.tsx` | Yes, except the usage line ("Claude 62% of 5h · GPU 80%") and per-tile service status |
| [work-lane.webp](work-lane.webp) | `/p/:project/work?lane=` | `pages/project/Work.tsx`, `work/Steps.tsx`, `work/Composer.tsx`, `work/Inspector.tsx` | Yes, except: Watching only / Take over, composer chips (@ file, / command, attach image), hand off / fork (phase 4), context compaction count and "fresh session from handoff" |
| [work-overview.webp](work-overview.webp) | `/p/:project/work` | `work/Overview.tsx` | Yes |
| [inbox.webp](inbox.webp) | `/inbox` | `pages/Inbox.tsx` | Yes. Review items open the Review page; approval items open the lane |
| [setup.webp](setup.webp) | `/setup` | `pages/Setup.tsx`, `setup/Agents.tsx` | Yes. The terminal block shows `contextlanes setup` rather than the install line; agents use Ready / Install / Sign in instead of toggles |
| [settings.webp](settings.webp) | `/settings` | `pages/Settings.tsx` | This machine, Access, Projects, Notifications, Lanes and Data. History retention waits for Insights |
| [models.webp](models.webp) | `/models` | `pages/Settings.tsx` (`ModelsPage`) | Agents, reported 5h/7d limits (unknown otherwise) and local models. Helper stats and routing in phases 3–4 |
| [review.webp](review.webp) | `/p/:project/review` | `pages/project/Review.tsx` | Yes, except Ask Codex to review, Shares a file with 02 (phase 3), changed-area highlights on screenshots and test counts. |
| [run.webp](run.webp) | `/p/:project/run` | `pages/project/Run.tsx` | Yes, except the Database fact, the watched list with Adopt into a lane, and certificate days |
| [architecture.webp](architecture.webp) | `/p/:project/architecture` | `pages/Static.tsx` | Phase 3 (`READY.architecture`) |
| [insights.webp](insights.webp) | `/p/:project/insights` | `pages/Static.tsx` | Phase 3 (`READY.insights`) |
| [phone-inbox.webp](phone-inbox.webp), [phone-lane.webp](phone-lane.webp) | same routes at 390px | same files | Yes, via the narrow-screen rules at the end of `app.css` |
| [legend.webp](legend.webp) | — | `components/ui.tsx` (`GLYPH`, `Tile`, `AgentMark`, `LaneBadge`) | Yes |

To re-export after the canvas changes, render each board at 1440px (390px for phone boards) and save as WebP.
