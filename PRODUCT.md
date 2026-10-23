# Rootlane

<!-- impeccable:product-schema 1 -->

## Platform

web

Rootlane is a private, single-owner project directory and development environment control service for a Linux host. Its purpose is a trustworthy project → environment → runtime → URL mapping.

## Stack

Web: React, TypeScript, Vite and ordinary CSS, with a Fastify backend and SQLite. One repository, package and backend process. Local stdio MCP forwards to that same backend. The user selected this stack.

## Approved first slice

Discover real directories and Git worktrees. Existing services are observe-only. Manage only owner-approved recipes or private config profiles. Project recipes remain authoritative; generated recipes stay in private host state; approval is an explicit owner session action bound to the recipe and toolchain revision. Each checkout has independently reserved instance ports and state. The acceptance fixture has no database or persistent application data. Record ownership and durable operations; verify readiness and preview status independently.

## UI direction

One full-width project row, with worktrees/environments, status, registered agents and useful links. Minimal navigation. Connected and Tailscale status replace an account menu. No system-stat cards. Five-second visible-page polling, one-second operation polling and immediate action refresh.

The approved visual authority is the user's Rootlane v5 HTML artboards and rootlane-v5.css: the Signal canvas, shared divided table and compact two-row header. Projects has Project, Branch, Agents, Services, Links and action columns, with cell padding preserving unbroken vertical dividers. Rows open a non-modal 660px right-side detail panel on desktop, with a remembered 1080px Widen toggle, filtered-order keyboard navigation and URL state. Below 1100px the project list opens full-screen detail with a Projects back button. Compact/Expanded row density remains browser-local. Overview maps real processes, bind addresses, managed readiness and independent URL verification; check strips retain 30 results, exposure includes network binds and observed Funnel routes, and recent changes use recorded observations. Logs are available only for recorded managed services, with cursor paging and visible-tab Follow. No system-stat cards. Expanded desktop avatars are 38px, compact and stacked avatars 26px. Ready/Available pills are green, Listening/Published blue and hollow, failed/stopped red and unchecked configured links grey. Every state comes from backend evidence. Agent-owned listener ports appear only with detected agents, while descendant services retain starting-agent attribution. Managed rows show verified state and capability-gated Start/Stop; approval, logs, editor and environment requests reuse backend authorization. Settings exposes owner-reviewed client repairs and opt-in telemetry setup. Fonts are self-hosted WOFF2 and official agent marks are inline SVG. All artboard names, ports, URLs and timestamps are placeholders; rendered values come from the real backend.

## Success and exclusions

Opt-in, agent-reported session telemetry: counts and names only, never content.

Acceptance requires the complete real lifecycle, safe failure/recovery, second-device preview/API/HMR, and actual tool calls from installed Codex and Claude Code. Mock-adapter tests are necessary but do not establish host acceptance.

No agent launching, transcripts, database actions, automatic worktrees, public previews, Compose management or multi-host orchestration.

## Recipe workflow

An agent uses locate → request_environment → owner review URL and polling → start_environment → get_environment. No agent edits private config or bypasses approval. Setup hints remain informational. Optional structured preparation has a separate owner review bound to commands, directories, expected writes and manifest/lockfile revisions. Commands launch directly with systemd-run; envFile values are private, read at start and never returned. Only names appear in reviews. Changed recipes or used toolchains require re-approval; recorded resources retain Stop and logs.

## Users

The installation owner and their local Codex and Claude Code agents use one Linux host. The owner reviews and approves lifecycle changes; agents act through the authenticated backend and local stdio MCP.

## Positioning

A private project directory maps real checkouts to processes, approved environments and independently verified preview URLs. Discovery grants no ownership or execution approval.

## Operating Context

Linux, user systemd and Tailscale provide the host runtime. Work starts from a project or Git worktree, progresses through owner review when needed, and is observed in the dashboard or through the same backend's MCP tools.

## Evidence on Hand

PRODUCT.md and DESIGN.md record the approved product and interface. README.md, docs/TELEMETRY.md and deploy/RELEASE.md describe setup and operation. Tests and `.impeccable/review/` contain implementation checks and screenshots; synthetic fixtures remain labelled and do not establish real-host acceptance. The 2026-10-19 audit includes live process, telemetry, MCP and responsive-browser evidence.

## Product Principles

- Show observed evidence and distinguish unknown, listening, ready and available states.
- Require owner approval and recorded ownership before lifecycle changes.
- Keep telemetry opt-in and retain only allowed counts and names.
- Use one backend for the dashboard and local MCP tools.

## Environment workflow

Configure → review preparation when needed → approve and start → Open → monitor → Stop or Recover. Checkout controls use branch/path selection and valid approval can be reused across unchanged worktrees. Missing checkout records retain cleanup/retirement actions. Generated configurations enable bounded systemd crash recovery; reboot restoration remains a separate owner choice, disabled by default. Healthy applications survive publication/HTTPS failure and Tailscale outages. Recovery repairs only recorded absent routes and preserves conflicts.
