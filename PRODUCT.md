# Rootlane

Rootlane is a private, single-owner project directory and development environment control service for a Linux host. Its purpose is a trustworthy project → environment → runtime → URL mapping.

## Platform and stack

Web: React, TypeScript, Vite and ordinary CSS, with a Fastify backend and SQLite. One repository, package and backend process. Local stdio MCP forwards to that same backend. The user selected this stack.

## Approved first slice

Discover real directories and Git worktrees. Existing services are observe-only. Manage only owner-approved recipes or private config profiles. Recipes default to committed project files; approval is an explicit owner session action bound to the recipe and toolchain revision. Each checkout has independently reserved instance ports and state. The acceptance fixture has no database or persistent application data. Record ownership and durable operations; verify readiness and preview status independently.

## UI direction

One full-width project row, with worktrees/environments, status, registered agents and useful links. Minimal navigation. Connected and Tailscale status replace an account menu. No system-stat cards. Five-second visible-page polling, one-second operation polling and immediate action refresh.

The approved visual authority is the user's replacement observation interface, superseding the earlier Signal HTML/image reference: a restrained near-black canvas with a faint grid, 64px desktop navigation and a maximum 1400px content area. Projects uses one rounded shared table with Project, Branch, Agents, Services, Links and menu columns in 22/12/26/18/16/6 proportions. Individual 38px agent circles show actual detected-process uptime; service lines show name and port, and concise real links become green only after verified health. Static rows offer Details, capability-gated Logs and Copy path in their menu. Details opens in a desktop side panel and fullscreen at 999px and below, where table rows also stack. Recipe authorization, environment requests, lifecycle, publication and recorded logs controls live in Details and remain governed by backend capabilities. Settings is read-only. Projects contains the owner approval/rejection review; agents can only request approval. Names, statuses, ports and URLs in historical mockups are illustrative; rendered content must come from the real backend.

## Success and exclusions

Acceptance requires the complete real lifecycle, safe failure/recovery, second-device preview/API/HMR, and actual tool calls from installed Codex and Claude Code. Mock-adapter tests are necessary but do not establish host acceptance.

No agent launching, transcripts, database actions, automatic worktrees, public previews, Compose management or multi-host orchestration.

## Recipe workflow

An agent uses locate → request_environment → owner review URL and polling → start_environment → get_environment. No agent edits private config or bypasses approval. Setup hints are informational and never executed. Commands launch directly with systemd-run; envFile values are private, read at start and never returned. Only names appear in reviews. Changed recipes or used toolchains require re-approval; recorded resources retain Stop and logs.
