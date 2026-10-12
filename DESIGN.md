---
name: Rootlane
description: "Signal v5: a compact private workspace for project, runtime and URL observations."
colors:
  bg: "#05060a"
  bg-2: "#0a0c12"
  glass: "rgba(255,255,255,.035)"
  glass-2: "rgba(255,255,255,.06)"
  glass-3: "rgba(255,255,255,.09)"
  inset: "rgba(0,0,0,.28)"
  stroke: "rgba(255,255,255,.075)"
  stroke-2: "rgba(255,255,255,.13)"
  stroke-3: "rgba(255,255,255,.22)"
  text: "#f2f4f8"
  text-2: "#c9cfdb"
  muted: "#8e96a8"
  faint: "#646c7e"
  accent: "#8b97ff"
  accent-strong: "#5b68ff"
  accent-glow: "rgba(91,104,255,.35)"
  ok: "#3fe0a0"
  ok-bg: "rgba(63,224,160,.1)"
  ok-stroke: "rgba(63,224,160,.28)"
  info: "#86aaff"
  info-bg: "rgba(134,170,255,.1)"
  info-stroke: "rgba(134,170,255,.26)"
  idle: "#9aa2b4"
  idle-bg: "rgba(154,162,180,.08)"
  idle-stroke: "rgba(154,162,180,.18)"
  warn: "#ffbe6b"
  warn-bg: "rgba(255,190,107,.1)"
  warn-stroke: "rgba(255,190,107,.3)"
  bad: "#ff8a8a"
  bad-bg: "rgba(255,120,120,.1)"
  bad-stroke: "rgba(255,120,120,.3)"
typography:
  headline:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-.035em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.5
  status:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1
  metadata:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
  label:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "10.5px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: ".14em"
  section-heading:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-.01em"
  panel-meta:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "6px"
  control: "8px"
  default: "10px"
  lg: "16px"
  xl: "20px"
  table: "16px"
  pill: "999px"
spacing:
  tight: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  panel: "20px"
  section: "24px"
  page: "28px"
  panel-section: "18px"
  detail-row: "10px"
  agent-row: "14px"
components:
  button-primary:
    backgroundColor: "linear-gradient(180deg,#6b78ff,#5260f5)"
    textColor: "#fff"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "34px"
    typography: "{typography.control}"
  button-secondary:
    backgroundColor: "{colors.glass-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "34px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "34px"
  search:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.text}"
    rounded: "{rounded.default}"
    padding: "0 6px 0 12px"
    height: "38px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "7px"
    padding: "0 12px"
    height: "32px"
  status-working:
    backgroundColor: "{colors.ok-bg}"
    textColor: "{colors.ok}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "26px"
    width: "min(100%, 230px)"
  status-unverified:
    backgroundColor: "rgba(134,170,255,.08)"
    textColor: "{colors.info}"
    rounded: "{rounded.pill}"
    height: "26px"
    width: "min(100%, 230px)"
  status-down:
    backgroundColor: "{colors.bad-bg}"
    textColor: "{colors.bad}"
    rounded: "{rounded.pill}"
    height: "26px"
  status-link:
    backgroundColor: "rgba(255,255,255,.04)"
    textColor: "{colors.text-2}"
    rounded: "{rounded.pill}"
    height: "26px"
  status-small:
    rounded: "{rounded.pill}"
    height: "22px"
    padding: "0 8px"
  filter:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "32px"
  project-table:
    backgroundColor: "linear-gradient(180deg,rgba(255,255,255,.035),rgba(255,255,255,.015))"
    textColor: "{colors.text}"
    rounded: "{rounded.table}"
  agent-circle:
    rounded: "50%"
    size: "38px"
  agent-compact:
    rounded: "50%"
    size: "26px"
  details-panel:
    backgroundColor: "rgba(10,12,18,.92)"
    textColor: "{colors.text}"
    width: "min(660px, 100vw)"
    padding: "0 20px 24px"
  details-panel-wide:
    width: "min(1080px, 100vw)"
  details-mobile:
    backgroundColor: "#07080d"
    textColor: "{colors.text}"
    width: "100vw"
    padding: "12px"
  panel-section:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "0"
    padding: "18px 0"
    typography: "{typography.section-heading}"
  detail-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "0"
    padding: "10px 0"
  usage-meter:
    backgroundColor: "{colors.glass-3}"
    textColor: "{colors.ok}"
    rounded: "{rounded.pill}"
    height: "6px"
    width: "100%"
  agent-list-avatar:
    rounded: "50%"
    size: "34px"
  agent-list-row:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "0"
    padding: "14px 0"
---
# Design System: Rootlane 0.8.0

## Overview

**Creative North Star: "Signal"**

Signal v5 keeps real project, runtime and URL observations in one divided table on a near-black canvas. Compact chrome, quiet glass, local Geist typography and restrained semantic color make a dense private workspace easy to scan. A fading grid and soft ambient violet light sit behind the content.

The pinned Signal v5 artboards and CSS remain the visual authority. Rootlane 0.8.0 extends that world with flat, divided sections shared by every detail tab and Settings. Project summaries stay in the shared table, while runtime evidence and optional agent-reported counts open beside them on desktop and in a full-screen dialog on mobile. Artboard and review-fixture names, counts, uptime, states and URLs are examples, never host evidence.

**Key Characteristics:**
- One rounded shared table with continuous column and row dividers.
- Compact two-row page header and segmented navigation, density and detail tabs.
- Evidence-based service and link pills with explicit text and dot shapes.
- Flat detail and Settings sections with shared label/value rows and quiet secondary metadata.
- Detail panel, 38px expanded project-row agent marks, 26px overlapping compact marks and 34px telemetry-list marks with observed context rings.

## Colors

The normative frontmatter preserves the incumbent Signal palette. Violet is the navigation/focus/action accent; mint, observation blue and failure rose encode independent runtime evidence. Near-black surfaces and translucent white strokes carry structure.

### Primary
- **Signal Violet** (`accent`, `accent-strong`, `accent-glow`): selection, focus and primary action glow. Primary buttons retain a restrained violet gradient.

### Secondary
- **Verified Mint** (`ok` family): reviewed application readiness and verified HTTPS availability.
- **Observation Blue** (`info` family): a listening socket or a published route awaiting verification.
- **Failure Rose** (`bad` family): stopped services, failed readiness, or failed HTTPS/upstream checks.
- **Attention Amber** (`warn` family): notices, pending authorization and unavailable tailnet observations; keep these separate from readiness.

### Neutral
- **Midnight** (`bg`, `bg-2`): canvas, shell and recessed controls.
- **Glass** (`glass` family, `inset`): light control and table layering.
- **Fine Stroke** (`stroke` family): continuous dividers, borders and hover feedback.
- **Cool White** (`text`, `text-2`): names and primary content.
- **Slate** (`muted`, `faint`, `idle` family): metadata, unchecked configured links and missing observations.

**The Evidence Rule.** A socket is not application readiness; publication is not HTTPS verification. Only Ready and Available receive green service and link pills. Stale or missing observations lose positive coloring and display “—”. Agent registration and process detection never imply activity or completion.

Context rings and usage-limit meters use mint below 60%, amber from 60% through 85%, and rose above 85%. These report usage, independently of runtime readiness. The context bar uses three violet shades for cache read, cache write and new input; the labelled breakdown makes each segment explicit.

## Typography

Geist is the interface family; Geist Mono distinguishes paths, branches, ports, times, counts and commands. Both variable fonts are local WOFF2 assets with the bundled OFL license. Keep the sans `ss01` and tabular-number features, and the mono slashed-zero feature.

| Role | Use |
| --- | --- |
| Headline | 24px, weight 600, line height 1.2; Projects, Unlock and review headings |
| Title | 15px, weight 600; desktop project names (14px on phones) |
| Body | 14px, weight 400, line height 1.5; explanations and content |
| Control | 12–13px, weight 500; buttons, navigation and filters |
| Pill | 12.5px, weight 500; 11px for small detail pills |
| Metadata | 12px mono; phone paths/branches 10.5px; actual uptime 10px |
| Label | 10.5px mono, weight 500, .14em spacing; compact uppercase technical labels |
| Section heading | 13.5px, weight 600; flat panel and Settings section titles |
| Panel metadata | 11.5px mono; muted labels, section asides and secondary row facts |

**The Technical Type Rule.** Use Geist for interface language and Geist Mono for technical identifiers; preserve tabular numerals and wrap complete values in Details.

## Layout

The sticky desktop topbar is 64px tall with brand, segmented Projects/Settings navigation, centered search and actual connection/tailnet status. The content wrapper has a 1440px maximum including 28px side padding, and 28px top/64px bottom padding. The Projects header uses compact title/count/root, filters and semantic legend controls.

At 1100px and above, header and project rows use the same six-column grid: `minmax(0,1.7fr) minmax(0,.9fr) minmax(0,1.25fr) minmax(0,1.25fr) minmax(0,1.25fr) 84px` for Project, Branch, Agents, Services, Links and actions. Align row contents to the top. Put vertical row spacing inside the cells, with zero grid gap and zero outer vertical row padding, so vertical dividers meet horizontal dividers without gaps. Keep the shared 20px horizontal table inset. Header cells use 14px top/12px bottom spacing; expanded cells use 18px vertical spacing, compact cells 9px. Do not introduce separate project card gaps.

Below 1100px, hide the shared header and show project identity, path/branch, overlapping agent marks and compact evidence summaries. At these stacked widths, project identity includes the branch, 26px agent marks overlap beside it, and actions remain reachable. Mobile rows show working, unverified and on-network summary pills; density controls desktop summary size. On phones (760px and below), use 16px page gutters and wrap technical values. The shell wraps navigation and search; search/password text is 16px to avoid focus zoom. Interactive controls have at least 44px phone targets even when the visible pill is smaller. Honor safe-area insets.

At desktop widths, the non-modal detail panel overlays the right of the table below the 64px shell header. Its body scrolls independently, with 20px horizontal padding and flat sections divided by top hairlines; Widen changes its width and remembers that choice locally. Below 1100px, details fill the viewport in a modal dialog with a 12px horizontal body inset. On phones (760px and below), that body inset is 16px. The mobile ‹ Projects and previous/next navigation sits above project identity. The tab strip scrolls horizontally rather than wrapping. Runtime records stack the address:port → destination mapping; complete paths, URLs, hashes and environment names remain accessible. Selection highlights the originating table row with a quiet violet surface and a 3px inset accent edge.

All detail tabs and the General, MCP and Agent telemetry Settings views share flat sections with 18px vertical padding and a 1px top hairline, without a background box, rounded perimeter or inset shadow. A section title sits beside an optional muted mono aside. Label/value rows have their own top hairline and a `116px minmax(0,1fr) auto` grid. At 760px and below, rows become `90px minmax(0,1fr)` and their aside moves below the value. Settings has a 960px maximum width and a horizontally scrolling segmented view selector. Agent list rows retain their context ring on phones; tool-call p95 and failures move to a second line beneath the tool name.

## Elevation & Depth

Use faint ambient violet/mint gradients and a 56px grid fading through the upper 520px. Glass surfaces combine fine strokes with a subtle inset highlight. The shared table has one rounded perimeter and inset highlight; the detail panel uses a dark surface over the right of the table. Do not lift individual project rows.

Primary actions retain their inset highlight and soft violet shadow; native row popovers use `0 8px 28px #0008`. The green working dot alone receives a small glow; blue unverified dots remain hollow. Hover feedback is a restrained surface change. Honor reduced-motion preference by removing transitions and animation.

**The Divider Rule.** Shared alignment and uninterrupted dividers carry hierarchy; spacing belongs inside cells, never between them.

## Shapes

The project table uses 16px rounded corners and clipped contents. Detail and Settings sections and their evidence tables have square, unboxed edges; search and segmented frames retain 10px corners, standard controls 8px and Unlock 20px. Service/link pills are fully rounded. Usage meters are 6px tall with fully rounded ends. Icons use local inline SVG, ordinarily 16px with rounded linework; compact pill icons use 12px.

Agent circles are 38px with 24px artwork in Expanded desktop rows. Compact circles are 26px with 17px artwork, a separating surface ring, 7px overlap and a same-size `+N` remainder after four marks. Stacked tablet/phone circles are 26px and overlap by 9px; hide uptime at compact/phone density. Claude and Codex use the supplied official inline SVG vendor marks; unknown agents use initials. Accessible labels identify the vendor, evidence source and actual process uptime when known.

Telemetry list and session-header circles are 34px with 21px vendor artwork. Observed context adds a thin usage ring around the same avatar; the project table adds only that ring to its existing marks. Match labels use small outlined pills: Matched in mint, Probable in amber and Process only in muted text. Toolkit names remain compact labels within detail rows, with explicit MCP connection status and plugin version when reported.

## Components

### Service and link pills

The visible legend uses this exact vocabulary:

| Legend | Treatment | Evidence / displayed state |
| --- | --- | --- |
| working | Green pill, filled glowing dot | Ready after reviewed readiness; Available after route + HTTPS + upstream verification |
| unverified | Blue pill, hollow dot | Listening socket; Published route awaiting verification |
| down | Red pill and dot | Stopped; readiness failed; HTTPS or upstream failed |
| link | Gray pill and dot | Configured link with no verification |
| Unknown | Neutral treatment and “—” | Missing, stale or unavailable observation |

Summary pills (`.lp`) are 26px high, fill their column up to 230px and use 10px horizontal padding. Put a service port at the trailing edge in mono; put the external-link icon at the trailing edge of link pills. Compact desktop summaries show the first service/link and a real `+N` details control; Expanded shows up to three. Small detail pills (`.lp.sm`) are 22px high with 8px horizontal padding. Semantic pills remain labels unless they represent a real link or action. Expose state through text, title and accessible label; color alone is insufficient.

### Navigation and density

Projects and Settings use the incumbent segmented navigation. Compact/Expanded changes desktop summary density only. Details uses segmented, horizontally scrolling tabs with keyboard Left/Right and Home/End navigation. There is no Expand all control.

### Rows and actions

Project names, paths, branches, agents, services and links bind to the real catalog. Only detected processes with observed start times show uptime. Lifecycle icon actions exist only for backend-authorized controls; the row menu offers Details, capability-gated Logs, approved editor links, Request environment when applicable, and Copy path. Menus preserve keyboard navigation, Escape/outside dismissal, viewport containment and focus restoration. Copy success or failure is announced.

### Buttons and fields

Secondary buttons use quiet glass and fine borders; ghost buttons use transparent resting surfaces; primary actions use the violet gradient. Hover brightens the surface, disabled controls preserve their labels, and keyboard focus remains visible: 2px accent outline with 3px offset, inset where needed to avoid clipping. Search has a leading inline SVG and optional desktop keycaps. Inputs are labeled; credential input uses password autocomplete. Phone controls maintain 44px targets.

### Project detail panel (0.8.0)

Desktop (≥1100px) uses an interactive, non-modal `aside` over the right of the table, 660px wide. Widen uses 1080px and persists per browser. The selected row has `.sel`; rows and action menus open the same panel. There is no inline expansion or separate project page. Compact/Expanded controls row summary density only. With panel focus, Up/Down or j/k navigate current filtered order. Escape closes and restores the originating row's button focus. Tabs support Left/Right, Home/End; the selected project and tab are stored in `?project=<id>&tab=<tab>` and restored on reload and back/forward. Counts remain absent until detail evidence has loaded. Logs is hidden for unmanaged projects.

Overview orders Runtime map, Checks, Exposure and Recent changes. Runtime rows map a real process and worktree/PID to every observed bind and matching backend URL. Reviewed services without routes say internal; observed listeners without routes say no route. Wildcard binds use warning color. Working means reviewed readiness passed; Listening does not establish readiness and Published does not establish HTTPS availability. Checks show the last 30 retained pass/fail/not-run results; readiness and preview HTTPS verification are labelled separately from observed route/HTTP checks. Observed HTTP uses the existing 30-second panel-scoped cache and says not readiness. Missing/stale current results show —. Exposure lists non-loopback binds and the loopback/preview fix; only a successful Serve observation can confirm no public (Funnel) routes and Loopback only. Recent changes shows three recorded events with an All activity link.

Logs has a recorded-service switcher, search, highlighted warnings/errors, Errors only, Timestamps, Follow, Copy and Download. Follow polls get_logs with its cursor every second only on the visible Logs tab; footer says journal since last start. Output is bounded to 2,000 loaded lines and keeps existing redaction/ownership checks. Services includes process, port, bind, PID, start time, owner and state. Worktrees retains the Git evidence table. Activity combines durable operations with recorded scan differences and pass↔fail changes; it never claims transcript or agent activity.

Below 1100px rows show identity, path/branch, overlapping vendor avatars, a mobile chevron and evidence-based working/unverified/on-network summaries. Opening uses full-screen `role=dialog` with focus containment, ‹ Projects, prev/next and capability-gated confirmed Stop. The scrolling tabs are Overview, managed Logs, Links, Agents and Worktrees. All activity opens a named Activity region within Overview, keeps Overview selected and offers Back to Overview. The runtime map stacks as address:port → destination; exposure and recent changes remain visible. Desktop remains non-modal. Strict CSP, local fonts, inline vendor marks, visible focus and reduced-motion support are preserved.

The panel uses a quiet blurred dark overlay and the shared flat section system throughout Overview, Logs, Services or Links, Agents, Worktrees and Activity. Checks retain compact pass/fail/not-run strips with distinct colors and accessible text; exposure warnings use the incumbent amber. Do not add system-stat cards, fabricated metrics, Restart, shell access, unmanaged logs or unsupported actions.

### Flat sections and detail rows

Section hierarchy comes from a top hairline, vertical spacing and a sans heading; secondary context sits in a muted mono aside. Rows align muted mono labels with wrapping values and optional trailing facts. Nested evidence tables lose their rounded wrapper, background and outer border. Keep the existing actions, statuses and log controls inside these sections. Do not replace panel or Settings content with card grids, metric tiles or standalone chip clusters.

### Agents

Agents opens as a divided list. Each session row shows its vendor ring avatar, model/worktree/elapsed metadata, observed context percentage and meter, one match label, and a disclosure control. Selecting a row replaces the list in place with the session detail; ‹ All agents returns to the list. Owner registrations remain labelled Registered with no observed process.

Agent-reported session details order Session, Context, Usage limits, Toolkit, Tool calls, Model and output, then Rootlane calls, followed by the counts-only privacy footnote. Session lists model, mode and observed process. Context exposes cache read/cache write/new input in a segmented bar and labelled breakdown, with cache hit and compactions as secondary facts. Usage limits shows reported 5-hour and 7-day percentages with resets. Missing or unsupported context and limits state that directly.

Toolkit groups MCP servers, skills and plugins into detail rows, with connection status and plugin version where reported. Tool calls is a compact Tool/Calls/Failures/p95 table sorted by call count, initially showing the top eight; Show all reveals the remainder. On phones, p95 and failures sit below the tool name. Model and output has exactly four primary rows: Requests, Errors, Tokens out and Changes; p95, refusals/rejects, cost and commits/PRs remain secondary asides. Rootlane calls is a separate counts table.

A Process only detail shows observed process, working directory and own ports, the absence of agent-reported telemetry, Rootlane calls and a setup link. It does not fabricate session sections or values. Telemetry display uses only agent-reported counts and names; it never reads transcripts or treats a running process as completion evidence.

### Details and setup

The detail panel preserves authorization, readiness and ownership boundaries. Environment requests, Start/Stop, Publish/Unpublish, recorded logs and owner reviews remain governed by the backend. Stop and Unpublish retain confirmation. Ready requires the reviewed readiness check; HTTP status is a separate observation. Planned preview URLs are allocated addresses, not availability claims. Recipe chips describe Approved, Pending approval, Stale, Invalid or Needs approval, never activity. Owner approval binds to the actual recipe/toolchain revision; secrets never appear in review values.

Settings stays read-only with General, MCP and the third Agent telemetry view. All three use the same flat sections and divided label/value rows. Agent telemetry shows receiver state, the live loopback endpoint and port, guarded credential Copy, retention and dropped counts, current reporting sessions and the last event time. Its numbered setup sections provide Claude telemetry configuration, session hooks, the optional existing status-line wrapper and Codex configuration, with readable code blocks and guarded Copy actions. The ingest token never appears in rendered HTML; only the authorized copy response supplies it. The privacy section states what is retained and dropped and how sessions match processes. Keep receiver failures, setup errors and stale reporting readable. Unlock uses the shared type, field and button system. The existing polling and authorization behavior remains intact.

Strict CSP requires self-hosted fonts/assets, ordinary stylesheet classes and local inline SVG marks. Do not add inline script/style attributes, data URLs or external fonts. Native popover placement may use the existing measured CSSOM positioning. Do not substitute artboard placeholders for backend values.

Review evidence lives in `.impeccable/review/`. The 0.8.0 captures in `telemetry-080/` cover `agent-list`, `claude-detail`, `codex-detail`, `process-only` and `settings` at 1440, 1100, 768 and 390px. Historical 0.7.0 panel captures are `v070-details-390.png` and `v070-details-1440.png`; `v070-projects-*` covers 390, 768, 1100, 1440 and 1920px. Earlier captures cover Compact, Settings, MCP, owner approval and Unlock. Screenshots establish visual behavior, not real-host acceptance.

## Do's and Don'ts

### Do:
- Do retain the shared table, continuous dividers and selected-row highlight beside the desktop panel.
- Do use evidence-based pill states and “—” for unknown observations.
- Do preserve real vendor marks, actual process uptime and full technical values.
- Do stack below 1100px and maintain reachable controls on phones.
- Do preserve local fonts, strict CSP, visible focus and reduced motion.
- Do use shared flat sections and divided label/value rows in every detail tab and Settings view.
- Do keep secondary telemetry facts in asides and explicitly label missing or unsupported reports.

### Don't:
- Don't infer readiness from listening or HTTPS availability from publication.
- Don't restore inline expansion, desktop disclosure chevrons, Expand all, a separate project page or separate project cards.
- Don't assert artboard values as actual host data.
- Don't add external fonts, inline styles, data URLs, fabricated vendor logos or transcript-derived activity.
- Don't restore rounded evidence cards, metric tiles or standalone chip clusters in the panel or Settings.

The 0.7.1 evidence fixes require a matching recorded unit marker, invocation and listener control group before a process is labelled Rootlane-owned. Current check pills and the managed header clear to “—” when their source refresh fails; history strips remain visible. Mobile network summaries and Exposure use the bound address, independently of publication eligibility. Each Serve read contributes one route result per checkout and port. The first scan after a controller restart establishes a baseline, and retained events remain associated with their parent project after checkout removal.
