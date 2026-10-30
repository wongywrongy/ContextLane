# Mockups

Exported from the design canvas (page v4, "Full site"). These are the reference for every screen. The web app ports the canvas CSS into `apps/web/src/styles/app.css` with the same class names (`.sec`, `.wk3`, `.lrow`, `.st3`, `.compose`, `.tile`, `.need`, `.irow`, `.sst` …), so a board and its page can be compared side by side.

When a page and its board disagree, the board wins unless the data does not exist yet. In that case leave the element out (or behind a flag in `apps/web/src/features.ts`); never fill it with invented numbers.

| Board | Route | Code | Built |
|---|---|---|---|
| [projects.webp](projects.webp) | `/` | `pages/Projects.tsx`, `components/AddRepo.tsx` | Yes, except the usage line ("Claude 62% of 5h · GPU 80%") and per-tile service status (phase 2) |
| [work-lane.webp](work-lane.webp) | `/p/:project/work?lane=` | `pages/project/Work.tsx`, `work/Steps.tsx`, `work/Composer.tsx`, `work/Inspector.tsx` | Yes, except: Watching only / Take over, composer chips (@ file, / command, attach image), Environment block (phase 2), hand off / fork (phase 4), context compaction count and "fresh session from handoff" |
| [work-overview.webp](work-overview.webp) | `/p/:project/work` | `work/Overview.tsx` | Yes |
| [inbox.webp](inbox.webp) | `/inbox` | `pages/Inbox.tsx` | Yes. Review and approval items appear when phase 2 creates them |
| [setup.webp](setup.webp) | `/setup` | `pages/Setup.tsx`, `setup/Agents.tsx` | Yes. The terminal block shows `contextlanes setup` rather than the install line; agents use Ready / Install / Sign in instead of toggles |
| [settings.webp](settings.webp) | `/settings` | `pages/Settings.tsx` | Access, Projects, Notifications, Lanes. Machine and data sections later |
| [models.webp](models.webp) | `/models` | `pages/Settings.tsx` (`ModelsPage`) | Agents and local models. Limits, helper stats and routing in phases 3–4 |
| [review.webp](review.webp) | `/p/:project/review` | `pages/Static.tsx` | Phase 2 (`READY.review`) |
| [run.webp](run.webp) | `/p/:project/run` | `pages/Static.tsx` | Phase 2 (`READY.run`) |
| [architecture.webp](architecture.webp) | `/p/:project/architecture` | `pages/Static.tsx` | Phase 3 (`READY.architecture`) |
| [insights.webp](insights.webp) | `/p/:project/insights` | `pages/Static.tsx` | Phase 3 (`READY.insights`) |
| [phone-inbox.webp](phone-inbox.webp), [phone-lane.webp](phone-lane.webp) | same routes at 390px | same files | Yes, via the narrow-screen rules at the end of `app.css` |
| [legend.webp](legend.webp) | — | `components/ui.tsx` (`GLYPH`, `Tile`, `AgentMark`, `LaneBadge`) | Yes |

To re-export after the canvas changes, render each board at 1440px (390px for phone boards) and save as WebP.
