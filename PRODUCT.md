# Rootlane

Rootlane is a private, single-owner project directory and development environment control service for a Linux host. Its purpose is a trustworthy project → environment → runtime → URL mapping.

## Platform and stack

Web: React, TypeScript, Vite and ordinary CSS, with a Fastify backend and SQLite. One repository, package and backend process. Local stdio MCP forwards to that same backend. The user selected this stack.

## Approved first slice

Discover real directories and Git worktrees. Existing services are observe-only. Manage only owner-approved recipes or private config profiles. Recipes default to committed project files; approval is an explicit owner session action bound to the recipe and toolchain revision. Each checkout has independently reserved instance ports and state. The acceptance fixture has no database or persistent application data. Record ownership and durable operations; verify readiness and preview status independently.

## UI direction

One full-width project row, with worktrees/environments, status, registered agents and useful links. Minimal navigation. Connected and Tailscale status replace an account menu. No system-stat cards. Five-second visible-page polling, one-second operation polling and immediate action refresh.

The approved visual authority is the supplied Signal design in Rootlane UI.html: a sticky glass top bar with Projects/Settings navigation, search and real Tailscale connection status, and full-width cards that always show Agents, Services and Preview. Details stay collapsed by default and expand into worktree, agent, service, preview, activity and managed environment tabs. Lifecycle and recorded logs controls appear only for managed environments with backend capability. Settings is read-only. Projects contains the owner approval/rejection review; agents can only request approval. Names, statuses, ports and URLs in the mockups are illustrative; rendered content must come from the real backend.

## Success and exclusions

Acceptance requires the complete real lifecycle, safe failure/recovery, second-device preview/API/HMR, and actual tool calls from installed Codex and Claude Code. Mock-adapter tests are necessary but do not establish host acceptance.

No agent launching, transcripts, database actions, automatic worktrees, public previews, Compose management or multi-host orchestration.

## Recipe workflow

An agent uses locate → request_environment → owner review URL and polling → start_environment → get_environment. No agent edits private config or bypasses approval. Setup hints are informational and never executed. Commands launch directly with systemd-run; envFile values are private, read at start and never returned. Only names appear in reviews. Changed recipes or used toolchains require re-approval; recorded resources retain Stop and logs.
