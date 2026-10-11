---
name: Rootlane
description: "Signal v3: a compact private workspace for project, runtime and URL observations."
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
  details-inline:
    backgroundColor: "rgba(0,0,0,.22)"
    textColor: "{colors.text}"
    padding: "14px 20px 18px 52px"
---
# Design System: Rootlane 0.6.0

## Overview

**Creative North Star: "Signal"**

Signal v3 keeps real project, runtime and URL observations in one divided table on a near-black canvas. Compact chrome, quiet glass, local Geist typography and restrained semantic color make a dense private workspace easy to scan. A fading grid and soft ambient violet light sit behind the content.

Projects expand inline. Density changes the summary, while segmented detail tabs expose complete observations in place. The six supplied artboards in `Rootlane UI.html` and `rootlane-v3.css` establish the visual direction; `web/style.css` and React bindings implement it. This v3 specification supersedes earlier static-row and modal-Details guidance. Artboard project names, counts, uptime, states, URLs and setup values are examples, never evidence about the host.

**Key Characteristics:**
- One rounded shared table with continuous column and row dividers.
- Compact two-row page header and segmented navigation, density and detail tabs.
- Evidence-based service and link pills with explicit text and dot shapes.
- Inline details, 38px expanded agent marks and 26px overlapping compact marks.

## Colors

The normative frontmatter follows the v3 CSS palette. Violet is the navigation/focus/action accent; mint, observation blue and failure rose encode independent runtime evidence. Near-black surfaces and translucent white strokes carry structure.

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

**The Evidence Rule.** A socket is not application readiness; publication is not HTTPS verification. Only Ready and Available receive green pills. Stale or missing observations lose positive coloring and display “—”. Agent registration and process detection never imply activity or completion.

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

**The Technical Type Rule.** Use Geist for interface language and Geist Mono for technical identifiers; preserve tabular numerals and wrap complete values in Details.

## Layout

The sticky desktop topbar is 64px tall with brand, segmented Projects/Settings navigation, centered search and actual connection/tailnet status. The content wrapper has a 1440px maximum including 28px side padding, and 28px top/64px bottom padding. The Projects header uses two compact rows: title/count/root and actions first, filters and semantic legend second. Notices, updated age, Refresh, Sort, Compact/Expanded and Expand/Collapse all are real controls bound to observations and list state.

At 1100px and above, header and project rows use the same six-column grid: `minmax(0,1.7fr) minmax(0,.9fr) minmax(0,1.25fr) minmax(0,1.25fr) minmax(0,1.25fr) 84px` for Project, Branch, Agents, Services, Links and actions. Align row contents to the top. Put vertical row spacing inside the cells, with zero grid gap and zero outer vertical row padding, so vertical dividers meet horizontal dividers without gaps. Keep the shared 20px horizontal table inset. Header cells use 14px top/12px bottom spacing; expanded cells use 18px vertical spacing, compact cells 9px. Do not introduce separate project card gaps.

Below 1100px, hide the shared header and stack summary fields with labeled service/link sections. At these stacked widths, project identity includes the branch, 26px agent marks overlap beside it, and actions remain reachable. Expanded rows keep service/link summaries; collapsed Compact rows prioritize identity and reveal summaries when expanded. On phones (760px and below), use 16px page gutters and wrap technical values. The shell wraps navigation and search; search/password text is 16px to avoid focus zoom. Interactive controls have at least 44px phone targets even when the visible pill is smaller. Honor safe-area insets.

Details lives directly beneath its project row and spans the table. Indent its content 52px on desktop, 16px below 1100px. Shared rounded detail tables use aligned headers/cells, continuous vertical and horizontal divisions, and top-aligned content. Below 1100px they become labeled records; labels use 90px at stacked widths, with flexible wrapping values. Activity events have individual separators. Tabs wrap without clipping, and complete paths, URLs, hashes and environment names stay accessible.

## Elevation & Depth

Use faint ambient violet/mint gradients and a 56px grid fading through the upper 520px. Glass surfaces combine fine strokes with a subtle inset highlight. The shared table has one rounded perimeter and inset highlight; expanded details use a recessed dark tone rather than a floating panel. Do not lift individual project rows.

Primary actions retain their inset highlight and soft violet shadow; native row popovers use `0 8px 28px #0008`. The green working dot alone receives a small glow; blue unverified dots remain hollow. Hover feedback is a restrained surface change. Honor reduced-motion preference by removing transitions and animation.

**The Divider Rule.** Shared alignment and uninterrupted dividers carry hierarchy; spacing belongs inside cells, never between them.

## Shapes

The project table uses 16px rounded corners and clipped contents. Detail tables, search and segmented frames use 10px; standard controls use 8px, setup sections 16px and Unlock 20px. Service/link pills are fully rounded. Icons use local inline SVG, ordinarily 16px with rounded linework; compact pill icons use 12px.

Agent circles are 38px with 24px artwork in Expanded desktop rows. Compact circles are 26px with 17px artwork, a separating surface ring, 7px overlap and a same-size `+N` remainder after four marks. Stacked tablet/phone circles are 26px and overlap by 9px; hide uptime at compact/phone density. Claude and Codex use the supplied official inline SVG vendor marks; unknown agents use initials. Accessible labels identify the vendor, evidence source and actual process uptime when known.

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

Projects/Settings, Compact/Expanded, Settings sections and inline detail tabs share recessed segmented frames with a brighter selected surface. Use actual buttons, `aria-current` for page navigation, `aria-pressed` for density/filter selection and tab roles with roving focus for details. Detail sections are Worktrees, Agents, Services, Links, Environment and Activity, subject to real data and capabilities. Tabs support Left/Right, Home and End.

### Rows and actions

A row’s disclosure button toggles its inline details and exposes `aria-expanded`/`aria-controls`; row pointer activation is a convenience alongside the real button. Interactive descendants stop row toggling. Multiple projects may remain expanded. Expand/Collapse all affects the visible page. Density persists locally when storage is available.

Project names, paths, branches, agents, services and links bind to the real catalog. Only detected processes with observed start times show uptime. Lifecycle icon actions exist only for backend-authorized controls; the row menu offers Details, capability-gated Logs, approved editor links, Request environment when applicable, and Copy path. Menus preserve keyboard navigation, Escape/outside dismissal, viewport containment and focus restoration. Copy success or failure is announced.

### Buttons and fields

Secondary buttons use quiet glass and fine borders; ghost buttons use transparent resting surfaces; primary actions use the violet gradient. Hover brightens the surface, disabled controls preserve their labels, and keyboard focus remains visible: 2px accent outline with 3px offset, inset where needed to avoid clipping. Search has a leading inline SVG and optional desktop keycaps. Inputs are labeled; credential input uses password autocomplete. Phone controls maintain 44px targets.

### Details and setup

Inline details preserve authorization, readiness and ownership boundaries. Environment requests, Start/Stop, Publish/Unpublish, recorded logs and owner reviews remain governed by the backend. Stop and Unpublish retain confirmation. Ready requires the reviewed readiness check; HTTP status is a separate observation. Planned preview URLs are allocated addresses, not availability claims. Recipe chips describe Approved, Pending approval, Stale, Invalid or Needs approval, never activity. Owner approval binds to the actual recipe/toolchain revision; secrets never appear in review values.

Settings stays read-only. General and MCP sections use the same segmented controls, rounded divided records, copyable real commands and restrained callouts. Unlock uses the shared type, field and button system. Keep errors and retained/stale observations readable. The existing polling and authorization behavior remains intact.

Strict CSP requires self-hosted fonts/assets, ordinary stylesheet classes and local inline SVG marks. Do not add inline script/style attributes, data URLs or external fonts. Native popover placement may use the existing measured CSSOM positioning. Do not substitute artboard placeholders for backend values.

Review evidence lives in `.impeccable/review/`: Projects and Details at 390, 768, 1100, 1440 and 1920px; Compact at 390/1440px; Settings, MCP and owner approval at 390/1440px; Unlock at 1440px. Screenshots establish visual behavior, not real-host acceptance.

## Do's and Don'ts

### Do:
- Do retain one shared table, inline expansion and continuous cell dividers.
- Do use evidence-based pill states and “—” for unknown observations.
- Do preserve real vendor marks, actual process uptime and full technical values.
- Do stack below 1100px and maintain reachable controls on phones.
- Do preserve local fonts, strict CSP, visible focus and reduced motion.

### Don't:
- Don't infer readiness from listening or HTTPS availability from publication.
- Don't restore static rows, a modal Details layout or separate project cards.
- Don't assert artboard values as actual host data.
- Don't add external fonts, inline styles, data URLs, fabricated vendor logos or transcript-derived activity.
