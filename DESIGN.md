---
name: Rootlane
description: "Signal: a private workspace for trustworthy project, runtime and URL observations."
colors:
  bg: "#05060a"
  bg-2: "#0a0c12"
  table: "#0c0f16"
  table-head: "#10141c"
  agent: "#161b25"
  agent-claude: "#241b19"
  agent-claude-mark: "#e69570"
  glass: "rgba(255,255,255,.035)"
  glass-2: "rgba(255,255,255,.06)"
  glass-3: "rgba(255,255,255,.09)"
  inset: "rgba(0,0,0,.28)"
  stroke: "rgba(255,255,255,.075)"
  stroke-2: "rgba(255,255,255,.13)"
  stroke-3: "rgba(255,255,255,.22)"
  text: "#f2f4f8"
  text-2: "#c9cfdb"
  muted: "#929eb2"
  faint: "#929aad"
  accent: "#86aaff"
  accent-strong: "#527cff"
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
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-.035em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
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
  table: "14px"
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
    typography: "{typography.control}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "34px"
    typography: "{typography.control}"
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
  status-info:
    backgroundColor: "{colors.info-bg}"
    textColor: "{colors.info}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "22px"
    typography: "{typography.status}"
  filter:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "32px"
  project-table:
    backgroundColor: "{colors.table}"
    textColor: "{colors.text}"
    rounded: "{rounded.table}"
  project-row:
    textColor: "{colors.text}"
    padding: "22px 20px"
  agent-circle:
    backgroundColor: "{colors.agent}"
    rounded: "50%"
    size: "38px"
  details-panel:
    backgroundColor: "{colors.table}"
    textColor: "{colors.text}"
    padding: "24px"
    width: "min(900px, 90vw)"
  technology-tag:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.text-2}"
    rounded: "5px"
    padding: "0 7px"
    height: "20px"
---
# Design System: Rootlane

## Overview

**Creative North Star: "Signal"**

Signal places trustworthy project, runtime and URL observations in one shared table on a restrained near-black canvas. Fine borders, quiet blue links and a faint fading grid support scanning. The user's approved replacement interface supersedes the earlier Signal HTML/image references; those files remain historical evidence. The shipped React components and ordinary CSS define the implemented system.

Geist provides compact interface text; Geist Mono distinguishes paths, ports, branches, times and counts. Rows remain static. Project actions open Details in a side panel, keeping the shared table concise and the full observations accessible.

**Key Characteristics:**
- One rounded table with aligned Project, Branch, Agents, Services, Links and menu columns.
- Individual circular vendor marks with actual detected-process uptime.
- Compact service name/port lines and useful real links.
- Desktop Details side panel and fullscreen Details below 1000px.

## Colors

Near-black neutrals carry pale text, quiet blue focus and links, and small semantic green, amber and red signals. Frontmatter records the final CSS values, including overrides. Violet gradient primary controls remain in Unlock and existing capability flows; they do not establish an ambient violet background for Projects.

### Primary
- **Signal Blue** (`accent`, `accent-strong`): keyboard focus, selected counts, links and text selection.

### Secondary
- **Verified Mint** (`ok` family): verified connection, reviewed application readiness and HTTPS availability. Service dots also identify an observed listening socket; listening does not imply application readiness.
- **Observation Blue** (`info` family): registered agents, detected processes, listening services and published routes in Details.
- **Attention Amber** (`warn` family): attention, pending work and unavailable tailnet observations.
- **Failure Rose** (`bad` family): failed operations and destructive-state observations.

### Neutral
- **Midnight Canvas** (`bg`, `bg-2`): page and topbar surfaces.
- **Observation Surface** (`table`, `table-head`): shared table, header and Details panel.
- **Translucent Glass** (`glass` family) and **Inset Black** (`inset`): existing controls, setup boxes and technical commands.
- **Fine White Stroke** (`stroke` family): borders, row separators and focus-within feedback.
- **Cool White** (`text`, `text-2`) and **Slate Metadata** (`muted`, `faint`): content, paths and labels.
- **Quiet Slate** (`idle` family): stopped, unknown and unverified observations.
- **Vendor Mark Surfaces** (`agent`, `agent-claude`, `agent-claude-mark`): circular agent tiles and the sourced Claude mark.

**The Evidence Rule.** Registered and Detected describe agent evidence; Listening describes a socket; Published describes a route. None is a claim of activity, completion or verified availability. A link becomes green only after HTTPS verification; stale observations lose positive row coloring. Dots expose their observed state through accessible labels or the link label.

## Typography

Locally hosted Geist variable serves interface text; Geist Mono variable serves technical values. Fonts ship from the official Vercel font repository with their OFL license. Interface text uses `ss01` and tabular numerals; monospace metadata uses the slashed-zero feature.

### Hierarchy
- **Headline:** Projects headings use 30px with a 1.2 line height.
- **Title:** project row names use 15px; Details titles use 22px; Settings setup titles retain 20px.
- **Body:** workspace base text uses 14px. Setup explanations retain 13px and a 1.65 line height.
- **Control:** standard controls use 12.5px; navigation and search use 13px.
- **Status:** Details chips use 11.5px.
- **Metadata:** row paths, branches, service ports and links use 12px; actual process uptime uses 10px.
- **Label:** technical headings retain compact monospace labels. Shared table headers use 12px Geist.

**The Technical Type Rule.** Use Geist for interface language and Geist Mono for technical identifiers and observations; retain tabular numerals.

## Layout

A sticky 64px desktop topbar combines brand, segmented Projects/Settings navigation, centered search (maximum 460px) and real connection/tailnet status. The outer container is 1456px including 28px side padding, leaving a maximum 1400px content area. Desktop main padding is 34px 28px. The toolbar precedes one table with a 16px gap.

The six shared columns use 22/12/26/18/16/6 proportions for Project, Branch, Agents, Services, Links and menu; the final column reserves at least 44px. Table header padding is 12px 20px; rows use 22px 20px padding and a 96px minimum height. Every project shares those columns and row dividers, with no separate card gaps. Project paths and branch labels may ellipsize on desktop; full values remain available in titles and Details. Agents wrap within their column; service and link summaries show up to three entries with explicit more links.

At 999px and below the header disappears and each static row stacks project identity, branch, agents, services and links. The menu stays beside identity. Paths and branches wrap; services and links wrap as compact horizontal lines. Details becomes fullscreen at the same breakpoint. At 760px and below, the topbar wraps into brand/connection, navigation and search rows; main padding becomes 24px 16px and row padding 16px. Controls retain at least 44px touch targets, search and password inputs use 16px to avoid focus zoom, and keyboard hints are omitted on phones. Safe-area insets protect the shell and page edges. At 1100px the chrome becomes more compact; it does not change the table structure.

One project opens in a modal Details side panel, `min(900px, 90vw)` wide and 100dvh tall on desktop, with 24px padding. Fullscreen Details uses 20px padding below 1000px and 16px below 761px. Tabs wrap and retain keyboard navigation. Detail tables render as labeled records at every width, using a label column of `minmax(90px, 25%)`, a flexible value column and a 16px gap; full paths and endpoints wrap within the value column. Settings and setup definition lists keep their existing responsive behavior.

## Elevation & Depth

Projects uses a flat near-black canvas with a 56px grid fading through the upper 520px at .28 opacity. The topbar is opaque `bg-2`, with no backdrop blur. The shared table and Details panel use opaque `table` surfaces, thin borders and divided rows. A dark `#0009` dialog backdrop separates Details from the table.

Existing controls and setup surfaces retain inset glass highlights; primary actions retain their existing violet gradient and soft action shadow. Menus use `0 8px 28px #0008`. Static project rows do not lift, expand or gain card shadows. Reduced-motion preference removes inherited transitions.

**The Surface Rule.** Let shared alignment, fine borders and restrained tonal changes carry hierarchy; keep depth attached to controls and overlays.

## Shapes

The shared table has 14px corners and clipped contents. Details is a rectangular edge-attached panel. Existing unlock panels use the 20px radius; search and technical boxes use 10px, setup sections 16px, controls 8px, and status/filter chips fully rounded corners. Vendor marks are 38px circles in rows, with 24px artwork and uptime underneath; Details keeps the existing compact mark treatment. Claude uses the sourced Anthropic Spark and Codex uses the sourced OpenAI Codex symbol. Initials remain the fallback.

Inline SVG line icons ordinarily use 16px round-capped linework; compact link icons use 12px. Thin separators preserve the table's common geometry.

## Components

### Buttons

Secondary actions retain restrained glass fills, fine borders and brighter hover surfaces. Primary controls retain the existing violet gradient; ghost controls remove resting fill and border. Standard desktop actions have a 34px minimum height, with 34px icon buttons. Disabled controls retain labels and reduced opacity. Unlock uses 42px; stacked-row and phone controls use 44px targets.

### Observation rows

Rows show the project name and short path, branch, individual agent circles, service name plus port, concise real links and a trailing menu. Uptime appears only for detected processes with an observed start time; registered-only agents have no invented duration. Unknown values remain “—”. Agent identity and evidence are available through accessible labels and titles. Service and link dots carry observed state rather than a claim of agent activity.

### Inputs / Fields

Search has a leading SVG icon, dark glass fill and shortcut keycaps on wider screens. Focus-within brightens the container border and surface. Credential input remains labeled with password autocomplete, an inset surface and a 44px height. Keyboard focus is a 2px blue outline offset by 3px; tab focus is inset to remain visible.

### Navigation

Projects/Settings navigation retains the recessed segmented frame and selected glass surface, with `aria-current`. Details tabs retain the accent underline, `aria-selected`, a roving tab stop and Arrow/Home/End support. Available sections are Worktrees, Agents, Services, Links, Environment and Activity, according to observed content and backend capability.

### Details, Actions and Technical Commands

The native row menu offers Details, Logs when backend log capability exists, and Copy path. Rows do not open on click. The menu supports arrows, Home/End, Escape and outside dismissal; positioning keeps it within the viewport. Details uses a native modal dialog, a visible Close button, Escape dismissal, scroll containment and focus restoration. The surrounding table remains static.

Recipe authorization, Request environment, lifecycle actions, publication controls, recorded logs and complete technical values live in Details. Each remains governed by the existing backend capability and owner approval rules. Copy operations announce success or failure. Settings remains read-only, including MCP setup; Projects retains the owner approval/rejection review.

Runtime details use observed service names, process start times and worktree state. Unknown values stay “—”. HTTP observations show status separately from semantic readiness chips; they never confer Ready. Ready requires the reviewed readiness check, and Available requires HTTPS verification. Activity shows bounded durable lifecycle and preview history with error codes.

The fast observation loop runs every five seconds; active operations refresh every second. Git metadata refreshes every sixty seconds or on HEAD/index changes. Only the project open in Details requests environment and preview readiness probes. Config reload and reconciliation failures use one status notice each. Stop and Unpublish require confirmation; retries preserve the click’s request ID. The shell displays active and failed durable action status without requiring Details to stay open; successful operations leave no persistent banner. Valid-session reauthentication stays available during login throttling.

Path links use the private host’s approved editorUrlTemplate. Without it, paths remain text with Copy. Proposal JSON stays unapproved, with literal readiness placeholders and exact host instructions to edit config.json and run rootlane-reload. Settings never writes config. Claude and Codex use locally sourced official inline React SVG marks. CSP allows only self-hosted assets; Geist fonts remain WOFF2 files and assetsInlineLimit is zero. Popovers assign measured viewport coordinates through CSSOM; no inline scripts or data URLs are required.

Recipe approval follows Signal's Operate mode. Details shows a glyph-and-label Recipe chip: Approved, Pending approval, Stale, Invalid, or Needs approval before the first request. This describes authorization, never activity or readiness. A toolbar notice counts pending environment reviews. Deep links open an owner review with the checkout, SHA256, toolchain revision, argument arrays, cwd, env names, allocated ports, reviewed readiness, planned previews and informational setup hints. Values and secrets are absent. Approve requires a confirmation; Reject does not launch or terminate services. Stale reviews offer Reject and ask for a new request. Settings remains read-only; approval/rejection is the owner review write, alongside existing lifecycle and route controls.

Environment details show each checkout instance with its ports, allocated preview URLs, application/route verification, Start/Stop and recorded logs. Planned URLs do not imply availability. The review heading receives keyboard focus; controls meet phone target sizing and hashes/path/env names wrap within the available width. Current interface evidence is `.impeccable/review/projects-{360,390,768,1280,1440}.png` and `.impeccable/review/details-{360,390,768,1280,1440}.png`. The older approval captures document the existing authorization flow, rather than the replacement table and panel styling.

## Do's and Don'ts

### Do:
- Do retain one shared table and static project rows.
- Do show individual real agent marks and actual detected-process uptime.
- Do show concise real links and require verification for green link state.
- Do retain the 999px stacked-row/fullscreen-Details breakpoint.
- Do wrap full technical values in labeled Details records.
- Do preserve local fonts, accessible state labels, keyboard focus and action failures.

### Don't:
- Don't infer activity from registration, readiness from a socket or HTTPS verification from publication.
- Don't restore separate project cards, inline row expansion or always-visible lifecycle controls.
- Don't use the historical Signal reference as authority over the approved replacement.
- Don't add account chrome, system-stat cards, editable Settings, dependencies or fabricated vendor logos.
