---
name: Rootlane
description: "A quiet private workspace for projects, services and preview links."
colors:
  bg: "#0c0c0c"
  bg-2: "#141414"
  glass: "rgba(255,255,255,.035)"
  glass-2: "rgba(255,255,255,.06)"
  glass-3: "rgba(255,255,255,.09)"
  inset: "rgba(0,0,0,.28)"
  stroke: "rgba(255,255,255,.075)"
  stroke-2: "rgba(255,255,255,.13)"
  stroke-3: "rgba(255,255,255,.22)"
  text: "#f5f5f5"
  text-2: "#d4d4d4"
  muted: "#a3a3a3"
  faint: "#929292"
  accent: "#e5e5e5"
  accent-strong: "#e5e5e5"
  accent-glow: "transparent"
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
    lineHeight: 1.5
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  control:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.5
  metadata:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "Geist Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.bg}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
---

# Rootlane interface

## Overview

This is the current interface direction, refined on 2026-10-23. It supersedes the earlier Signal artboards. Rootlane is a frequently used workspace for one owner: the interface should make running services, preview links and the next action easy to find.

## Colors

- Use flat, neutral surfaces. The page is `#0c0c0c`; raised content is `#141414`. No decorative grid, glow, gradient or backdrop blur.
- Keep status colors for observed state, errors and warnings. Primary actions use light text-colored fill with dark text. Do not color ordinary navigation as a status.
- Use the existing Rootlane mark, Geist and Geist Mono. Use mono for code, paths, ports and identifiers, rather than whole explanatory paragraphs.
- Page titles are 24px, detail titles 20px, subsection titles 14–18px, body 13–14px and supporting text 12px. Avoid text below 11px.
- Primary text is `#f5f5f5`, secondary `#d4d4d4`, muted `#a3a3a3` and tertiary `#929292`. Check actual foreground/background contrast when adding a surface.
- Use the shared CSS variables in `web/style.css`. Controls have 6px radii; larger surfaces use 8–12px. Use 4, 8, 12, 16, 24 and 32px spacing.

## Layout

The default list answers what is running and where to open it. Keep every observed service and link available in both row densities. Empty mobile service/link fields add no information and can be omitted; unavailable observations still have explicit warning text.

On desktop, opening details leaves a compact project navigator beside the panel. The wide panel supports closer inspection. Below 1100px, details take the full screen with a back button and a focus trap. Tables respond to the available panel width, including a narrow panel on a wide screen.

Show the selected checkout once, with its path directly below the selector. Keep errors, approval blockers, preparation cleanup and the next action visible. Put configuration notes, environment options, full link controls and identifiers behind labeled disclosures. Never hide the commands or dependency revisions being approved inside an unrelated settings section.

Discovery notices open bounded diagnostics. The normal project list should not contain a port inventory. No made-up activity, health, counts or success states.

## Components

Show connection or integration status first. Inspection, review and verification are distinct steps; show the exact proposed repair before its Apply button. Keep telemetry deletion in a separate maintenance disclosure with confirmation.

Telemetry shows receiver status and current reporting before manual client configuration. Setup snippets live in individual disclosures. Preserve the distinction between receiving data, matching a process and verifying a client tool call. Render credential placeholders; retrieve secrets only for the existing guarded Copy action.

## Do's and Don'ts

- Controls are at least 36px on desktop and 44px on phones. Use visible labels, proper button/link semantics and a visible keyboard focus indicator.
- Repeated actions, tabs, keyboard navigation and streaming observations update immediately. Avoid entry animation, stagger, layout animation and decorative movement.
- Pointer and press feedback uses color changes over 140ms with `cubic-bezier(0.23,1,0.32,1)`. Reduced-motion mode removes transitions. Hover-only effects require a fine pointer.
- Escape dismisses the active surface; focus returns to its trigger. Menu arrows skip disabled actions. Modifier shortcuts never change project selection. Search closes the phone dialog before focusing the search field.

### Verification

Run `npm run check` and `node tests/browser.mjs` after building. Inspect real-data desktop and phone captures, including errors, configuration/preparation review, setup disclosures and empty states. Responsive fixtures cover 360–1920px; they do not replace physical-device or assistive-technology testing.
