---
name: Rootlane
description: "A private project workspace with visible, trustworthy runtime state."
colors:
  primary: "#365bff"
  canvas: "#081119"
  chrome: "#0c1721"
  card-start: "#0d1a24"
  card-end: "#0d1922"
  control: "#14212e"
  control-hover: "#1b2b3d"
  text: "#edf2fc"
  muted: "#94a8c2"
  border: "#203140"
  focus: "#9ebaff"
  success: "#32e394"
  ready-dot: "#24dc83"
  registered-dot: "#8bb3ff"
  quiet-dot: "#8294ac"
  warning: "#ffce7e"
  icon: "#a8c7ff"
  nav-active: "#10213c"
  badge-bg: "#11354d"
  badge-text: "#78d2ff"
  badge-teal-bg: "#0b383d"
  badge-teal-text: "#7de0d6"
typography:
  headline:
    fontFamily: "Inter, sans-serif"
    fontSize: "34px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-.025em"
  title:
    fontFamily: "Inter, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-.015em"
  body:
    fontFamily: "Inter, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Inter, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.4
  detail:
    fontFamily: "Inter, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  badge: "6px"
  control: "8px"
  search: "9px"
  card: "12px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "14px"
  lg: "16px"
  xl: "18px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "white"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    height: "44px"
  search:
    backgroundColor: "#14212d"
    textColor: "{colors.text}"
    rounded: "{rounded.search}"
    padding: "0 14px"
    height: "46px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "#bfcef0"
    rounded: "{rounded.control}"
    padding: "14px 20px"
    height: "54px"
  badge:
    backgroundColor: "{colors.badge-bg}"
    textColor: "{colors.badge-text}"
    rounded: "{rounded.badge}"
    padding: "3px 11px"
    typography: "{typography.detail}"
  project-card:
    rounded: "{rounded.card}"
    padding: "14px 20px 13px"
---

# Design System: Rootlane

## Overview

**Creative North Star: "Local project control"**

A quiet, dark workspace follows the approved rootlane-ui-reference.png: blue-black surfaces, restrained blue actions, and compact project rows. The shipped React interface, ordinary CSS, local Inter font, and inline SVG icons are the visual source of truth.

Density supports scanning real projects and runtime observations. Color, labels, and disabled controls communicate what the backend knows; they never imply fictional agent activity or verified preview readiness.

**Key Characteristics:**
- Blue-black tonal surfaces with fine dividing borders.
- Compact, full-width project rows with inline expansion.
- Local Inter typography and consistent SVG line icons.
- Explicit status text alongside colored dots.

## Colors

The palette is blue-black and cool white, with blue for action and small semantic signals for verified state.

### Primary
- **Control Blue** (`primary`): the primary preview action and text selection.
- **Ice Blue** (`icon`, `focus`): SVG line icons and the keyboard focus outline.

### Secondary
- **Verified Green** (`success`, `ready-dot`): successful connection and independently ready managed runtime or preview state.
- **Observation Blue** (`registered-dot`): registered agents, observed listeners, and published links without a readiness claim.
- **Attention Amber** (`warning`): actionable warning text.
- **Technology Cyan / Teal** (`badge-*`): manifest-derived technology tags.

### Neutral
- **Deep Canvas** (`canvas`): page backdrop; a subtle upper-left radial wash sits over it.
- **Chrome** (`chrome`): header and navigation.
- **Project Surface** (`card-start`, `card-end`): the faint directional card gradient.
- **Control Surface** (`control`, `control-hover`): secondary actions and hover feedback.
- **Cool White / Slate** (`text`, `muted`): main content and secondary explanations.
- **Fine Border** (`border`): controls and separators; cards use closely related dark strokes.
- **Quiet Dot** (`quiet-dot`): unavailable or unverified state, always accompanied by text.

**The Evidence Rule.** Green means verified readiness or connection. Registered agents, observed listeners, and published routes use their explicit labels and quieter status colors.

## Typography

**Display and Body Font:** locally hosted Inter variable, with sans-serif fallback. No separate display face is used.

**Character:** compact, legible interface typography with tabular numerals. The font is intentionally pinned to the approved visual reference.

### Hierarchy
- **Headline:** page titles; headline token, reducing to 28px at the mobile breakpoint.
- **Title:** project names; title token, reducing to 18px on mobile.
- **Body:** controls, settings values, paths, and explanatory content.
- **Label:** section headings within project summaries.
- **Detail:** status text, tags, service rows, and timestamps.
- Brand lettering uses 26px / 600 with a tight line height; it reduces in the compact header. Detail headings use 15px / 500–550.

**The One Typeface Rule.** Use the shipped local Inter font for headings, interface text, and shortcut labels; preserve its tabular numerals and cv11 features.

## Layout

Desktop uses a 226px navigation column and an 82px header. The header and sidebar remain sticky; the search sits between branding and real connection indicators. Main content fills the available width with 28px top, 28px right, 24px bottom, and 32px left padding.

Project rows form one vertical list with 14px gaps. Their heading separates identity and counts from Agents, Services, Preview, and actions below. Details expand inside the same card. Worktree counts exclude the primary checkout.

At 1400px and below, actions move beneath the three summary columns. At 1000px and below, navigation narrows to 180px and controls wrap. At 700px and below, the header becomes static with search on its second row; navigation becomes horizontal, main padding becomes 24px 16px, Agents and Services form two columns, Preview spans the row, and actions form a two-column grid. Read-only Settings stacks its definition list. Long names, paths, and URLs wrap.

## Elevation & Depth

The workspace uses dark tonal layering, subtle gradients, and thin borders. Cards have no resting shadow and change only their border color on hover. The floating More menu uses `0 12px 25px #0008`; it is the shipped shadow vocabulary.

**The Quiet Surface Rule.** Use tonal separation and fine borders for the workspace; reserve the shipped shadow for the floating More menu.

## Shapes

Cards and folder-symbol tiles use the card radius; buttons use the control radius, search and menus the search radius, and technology tags the badge radius. Status markers are circles (13px in summaries, 9px in connection chrome). Standard line icons use a 24-unit SVG viewBox, round caps and joins, and a 1.7 stroke; their usual rendered size is 21px.

## Components

### Buttons

Restrained, bordered secondary actions share the control surface and cool text. The primary action uses Control Blue, white text, and a brighter blue hover. Standard actions have a 44px minimum height; card actions are 45px. Text-only disclosure buttons use a 32px minimum height. Disabled buttons keep their label, muted text, 0.65 opacity, and a not-allowed cursor. Keyboard focus is a 2px Ice Blue outline offset by 4px.

### Chips

Compact technology tags use cyan or teal tinted surfaces and detail text. Ownership remains plain secondary text rather than another badge. Tags describe detected manifests.

### Cards / Containers

Full-width project cards use a fine border, the Project Surface gradient, and compact padding. Heading and summary areas are separated by thin strokes. The folder tile anchors identity; explicit project state sits beside the title. Summary rows show up to two agents or services with an inline expansion control for the remainder.

### Inputs / Fields

Search uses a dark inset surface, a leading SVG search icon, and a bordered shortcut label. The input has no interior border and retains visible keyboard focus. Credential entry is a labeled password field; it shares the control radius and dark surface.

### Navigation

Projects and Settings are the only main navigation destinations. The selected item uses a deeper blue fill, pale blue text, and a thin blue left edge. Selection is also conveyed with aria-current. On mobile, the same destinations sit side by side.

### Inline Details and Actions

Counts and More disclose checkout details inline. Collapse returns focus to the project card. Folder opening is disabled when the browser cannot support it; preview links and managed-service log controls depend on real capabilities. Preview labels distinguish Published from verified Available. Settings exposes current connection and ownership information without editable controls.

Hover feedback on cards transitions over 160ms ease-out. Reduced-motion preference removes transitions. Menu actions return focus to the menu summary when they close it.

## Do's and Don'ts

### Do:
- Do preserve explicit state labels alongside status dots.
- Do keep project details collapsed initially and expand them inline.
- Do use the existing local font and SVG icon vocabulary.
- Do preserve visible keyboard focus and honest disabled controls.
- Do allow names, paths, and URLs to wrap on narrow screens.

### Don't:
- Don't promote Registered to active agent behavior, Listening to Ready, or Published to verified Available.
- Don't enable folder, preview, or logs controls without the corresponding capability.
- Don't add system-stat cards, account chrome, or editable Settings to this approved surface.
- Don't add a UI dependency to reproduce patterns already expressed in ordinary CSS.
