---
name: Rootlane
description: "Signal: a private workspace for trustworthy project, runtime and URL observations."
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
  faint: "#929aad"
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
    fontSize: "44px"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-.035em"
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-.02em"
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
  project-card:
    backgroundColor: "linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02))"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
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

Signal places clear project, runtime and URL observations on near-black glass. Soft violet and green ambient light, fine white borders, restrained inset highlights and a fading grid give the workspace depth without competing with its content. The user-pinned Signal HTML/CSS reference is the visual authority; the shipped React components and ordinary CSS define the implemented system.

Geist provides compact interface text; Geist Mono distinguishes paths, ports, branches, times and counts. Explicit labels and inline SVG symbols describe observed state. The interface must preserve Rootlane’s trustworthy mapping and ownership boundaries rather than infer agent activity or service readiness.

**Key Characteristics:**
- Near-black glass with subtle atmospheric light and fine borders.
- Geist interface typography paired with Geist Mono technical metadata.
- Full-width project cards with aligned summary panels and inline detail tabs.
- Semantic state chips with explicit text and inline SVG symbols.

## Colors

Near-black neutrals carry pale technical text, violet actions and small semantic green, blue, amber and red signals. Frontmatter values preserve the CSS source, including translucent colors; `faint` records the final readability override, not the reference’s original dimmer value.

### Primary
- **Signal Violet** (`accent`, `accent-strong`, `accent-glow`): keyboard focus, selected counts, links, primary controls and their ambient light.

### Secondary
- **Verified Mint** (`ok` family): verified connection, ready application and available preview states.
- **Observation Blue** (`info` family): registered agents, detected processes, listening services and published routes.
- **Attention Amber** (`warn` family): attention, pending work and unavailable tailnet observations.
- **Failure Rose** (`bad` family): failed operations and destructive-state observations.

### Neutral
- **Midnight Canvas** (`bg`, `bg-2`): page and scroll surfaces.
- **Translucent Glass** (`glass` family): controls, cards and selected surfaces; **Inset Black** (`inset`) recesses summaries and technical commands.
- **Fine White Stroke** (`stroke` family): borders, separators, hover and focus-within feedback.
- **Cool White** (`text`, `text-2`): primary and secondary content; **Slate Metadata** (`muted`, `faint`): paths, explanations and structural labels.
- **Quiet Slate** (`idle` family): stopped, unknown and not-exposed states, always as labeled chips rather than gray dots.

**The Evidence Rule.** Registered and Detected describe agent evidence; Listening describes a socket; Published describes a route. None is a claim of activity, completion or verified availability.

## Typography

**Body and Heading Font:** locally hosted Geist variable with UI sans-serif fallbacks.
**Technical Font:** locally hosted Geist Mono variable with UI monospace fallbacks. Fonts ship from the official Vercel font repository with their OFL license.

The pairing is compact and precise. Interface text uses `ss01` and tabular numerals; monospace metadata uses the slashed-zero feature.

### Hierarchy
- **Headline:** page headings use the headline token; mobile reduces them to 34px.
- **Title:** project names use the title token; mobile reduces them to 18px. Settings setup titles use 20px.
- **Body:** the workspace base uses the body token. Explanatory setup prose uses 13px with a 1.65 line height and an introductory measure of 78ch.
- **Control:** buttons, filters, tabs and table content use compact control typography; navigation and search use 13px.
- **Status:** semantic chips use the status token.
- **Metadata:** technical values use the metadata token; compact secondary rows use 11.5px and page root summaries 13px.
- **Label:** summary panel headings use the label token. Table headers use the same face and size with .12em tracking; these identify data structure rather than add promotional eyebrows.

**The Technical Type Rule.** Use Geist for interface language and Geist Mono for technical identifiers and observations; retain tabular numerals.

## Layout

A sticky topbar (64px) combines brand, segmented Projects/Settings navigation, centered search (maximum 520px) and real connection/tailnet status. Main content centers in a maximum 1320px container with desktop padding of 40px 28px 64px. Full-width project cards form a single list with 16px gaps; the toolbar wraps filters and sorting controls.

Card summaries have three columns in a 1.15:1:1 ratio for Agents, Services and Preview. At 1100px and below they become two equal columns with Preview spanning the next row. At 760px and below all three panels stack. That breakpoint also wraps the topbar into brand/connection, full-width navigation and search rows; main padding becomes 28px 16px 48px. Card headings wrap when actions require space, and a lone actions button stays beside the identity.

Details open inline for one project at a time. Horizontally scrolling tabs sit above tables or two-column information boxes; boxes and read-only definition lists stack on mobile. Tables preserve their columns in keyboard-focusable horizontal scroll containers. Names, paths and long values wrap where appropriate; compact summaries and preview URL pills may ellipsize.

## Elevation & Depth

Glass combines a faint white vertical gradient, fine stroke, inset top highlight, blur and a soft ambient shadow. Cards gain a larger ambient shadow and faint violet edge when opened. The topbar uses a translucent near-black background with stronger blur. The page carries three radial light washes and a 56px grid fading out over the upper 520px.

### Shadow Vocabulary
- **Glass highlight:** `inset 0 1px 0 rgba(255,255,255,.07)`.
- **Glass ambient:** `0 20px 40px -24px rgba(0,0,0,.8)`.
- **Open card:** `0 30px 60px -30px rgba(0,0,0,.9)` with a `0 0 0 1px rgba(139,151,255,.08)` edge.
- **Primary action:** brighter inset highlight and a `0 6px 20px -6px` accent glow.

**The Glass Rule.** Use translucent gradients, thin borders and inset highlights together; keep ambient shadows soft and attached to glass surfaces.

Card border and shadow changes use 160ms ease-out; reduced-motion preference removes transitions. Glass surfaces use blur(18px) saturate(140%), while chrome uses blur(20px) saturate(150%).

## Shapes

Project cards and unlock panels use the largest rounded token. Technical boxes, search and table containers use the default radius; setup sections use the large radius. Buttons and URL pills use the control radius; filter and status chips are fully rounded. Tags and keycaps have compact 5px corners, agent marks use 6px corners, and popovers use 12px corners. Thin borders and divided panels preserve alignment within these soft outer silhouettes.

Icons are inline SVG linework, ordinarily 16px with round caps and joins; chip symbols use 12px linework. Vendor mark slots are 22px tiles. Claude uses the sourced official Anthropic Spark; Codex uses the sourced official symbol from OpenAI's Codex IDE extension. Initials are a fallback, not a new logo system.

## Components

### Buttons

Secondary actions are restrained glass controls with a fine border, inset highlight and brighter hover surface. Primary actions use a violet gradient and glow; ghost actions remove their resting fill and border. Standard actions have a 34px minimum height; icon buttons are 34px squares. Disabled controls retain their label, reduced opacity and a not-allowed cursor. Unlock uses a taller primary control (42px).

### Chips

Semantic chips combine explicit state text with inline SVG checks, arrows, warning triangles, crosses or neutral strokes. Each state family pairs text, tinted background and matching stroke. They are informational and do not gain artificial hover behavior. Filter chips are interactive, with a selected glass surface, inset highlight, brighter border and violet count; `aria-pressed` exposes selection. Technology tags are neutral monospace labels derived from manifests.

### Cards / Containers

Project glass cards have separate identity/action headers, inset summary panels and a full-width Details bar. Header padding is 18px 20px 16px, summary padding 14px 20px 16px, and opened panels 16px 20px 20px; mobile uses 16px horizontal padding. Managed lifecycle and log actions appear only when ownership and capabilities allow them. Summary rows show up to three entries with explicit more links into details.

### Inputs / Fields

Search has a leading inline SVG icon, dark glass fill and compact shortcut keycaps. Focus-within brightens its border and surface; the native input outline is replaced by that visible container state. Credential input is labeled, uses password autocomplete, an inset surface and a 44px height. General keyboard focus is a 2px violet outline offset by 3px; tab focus moves the outline inward to remain visible inside the scroll strip.

### Navigation

Segmented navigation sits inside a recessed rounded frame. Selected destinations use brighter glass, an inset highlight and a thin surrounding stroke; `aria-current` conveys the page. Details tabs use a violet underline with `aria-selected`, a roving tab stop and Arrow/Home/End key support. Main and Settings navigation fill the mobile row.

### Details, Actions and Technical Commands

The native actions popover offers Copy path, Open in editor when an owner-configured template is present, read-only proposals, and Show/Hide details. Its near-opaque glass surface stays inside viewport limits, uses CSS anchor positioning when available and supports native Escape/outside dismissal with focus restoration. Technical tables and preformatted commands share inset or glass frames and monospace values. Copy commands expose success or failure text. Settings remains read-only and MCP setup stays within the same typography, boxes and semantic access chips.



Runtime details use observed service names, process start times and worktree state. Unknown values stay “—”. HTTP observations show status separately from semantic readiness chips; they never confer Ready. Ready requires the reviewed readiness check, and Available requires HTTPS verification. Activity shows bounded durable lifecycle and preview history with error codes.

The fast observation loop runs every five seconds; active operations refresh every second. Git metadata refreshes every sixty seconds or on HEAD/index changes. Only an expanded project requests environment and preview readiness probes. Config reload and reconciliation failures use one status notice each. Stop and Unpublish require confirmation; retries preserve the click’s request ID. The shell displays the durable action status through accepted, running and completion without requiring a card to stay expanded. Valid-session reauthentication stays available during login throttling.

Path links use the private host’s approved editorUrlTemplate. Without it, paths remain text with Copy. Proposal JSON stays unapproved, with literal readiness placeholders and exact host instructions to edit config.json and run rootlane-reload. Settings never writes config. Claude’s mark is an inline React SVG from Anthropic’s press asset; Codex retains CX until an official standalone mark is available. CSP allows only self-hosted assets; Geist fonts remain WOFF2 files, assetsInlineLimit is zero, and components use no inline style attributes or data URLs.

## Do's and Don'ts

### Do:
- Do pair state color with an explicit label and an inline SVG symbol.
- Do preserve the three, two and one panel layouts at the shipped breakpoints.
- Do use locally hosted Geist and Geist Mono and preserve visible keyboard focus.
- Do keep details inline, technical tables horizontally scrollable and long values able to wrap.
- Do show stale observations and action failures beside the affected content.

### Don't:
- Don't infer activity from an agent registration, readiness from a listening port or HTTPS verification from a published route.
- Don't restore gray status dots or replace explicit state labels with color alone.
- Don't add account chrome, system-stat cards or editable Settings to this approved workspace.
- Don't introduce a UI dependency or fabricated vendor logo to reproduce the shipped patterns.
