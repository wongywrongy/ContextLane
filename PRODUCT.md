# Rootlane

Rootlane is a private, single-owner project directory and development environment control service for a Linux host. Its purpose is a trustworthy project → environment → runtime → URL mapping.

## Platform and stack

Web: React, TypeScript, Vite and ordinary CSS, with a Fastify backend and SQLite. One repository, package and backend process. Local stdio MCP forwards to that same backend. The user selected this stack.

## Approved first slice

Discover real directories and Git worktrees. Existing services are observe-only. Manage only the disposable frontend/API fixture, which has no database or persistent application data. Record ownership and durable operations; verify readiness and preview status independently.

## UI direction

One full-width project row, with worktrees/environments, status, registered agents and useful links. Minimal navigation. Connected and Tailscale status replace an account menu. No system-stat cards. Five-second visible-page polling and immediate action refresh.

The approved visual authority is the supplied Signal design in Rootlane UI.html: a sticky glass top bar with Projects/Settings navigation, search and real Tailscale connection status, and full-width cards that always show Agents, Services and Preview. Details stay collapsed by default and expand into worktree, agent, service, preview, activity and managed environment tabs. Lifecycle and recorded logs controls appear only for managed environments with backend capability. Settings is read-only. Names, statuses, ports and URLs in the mockups are illustrative; rendered content must come from the real backend.

## Success and exclusions

Acceptance requires the complete real lifecycle, safe failure/recovery, second-device preview/API/HMR, and actual tool calls from installed Codex and Claude Code. Mock-adapter tests are necessary but do not establish host acceptance.

No agent launching, transcripts, database actions, automatic worktrees, public previews, Compose management or multi-host orchestration.
