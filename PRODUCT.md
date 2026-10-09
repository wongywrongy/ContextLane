# Rootlane

Rootlane is a private, single-owner project directory and development environment control service for a Linux host. Its purpose is a trustworthy project → environment → runtime → URL mapping.

## Platform and stack

Web: React, TypeScript, Vite and ordinary CSS, with a Fastify backend and SQLite. One repository, package and backend process. Local stdio MCP forwards to that same backend. The user selected this stack.

## Approved first slice

Discover real directories and Git worktrees. Existing services are observe-only. Manage only the disposable frontend/API fixture, which has no database or persistent application data. Record ownership and durable operations; verify readiness and preview status independently.

## UI direction

One full-width project row, with worktrees/environments, status, registered agents and useful links. Minimal navigation. Connected and Tailscale status replace an account menu. No system-stat cards. Five-second visible-page polling and immediate action refresh.

The approved visual authority is rootlane-ui-reference.png: dark header with search and connection status, Projects/Settings sidebar, compact full-width cards with Agents, Services, Preview and actions. Worktrees and environments expand inline from counts and stay collapsed by default. Settings is read-only. Names, statuses, ports and URLs in the reference are illustrative; rendered content must come from the real backend.

## Success and exclusions

Acceptance requires the complete real lifecycle, safe failure/recovery, second-device preview/API/HMR, and actual tool calls from installed Codex and Claude Code. Mock-adapter tests are necessary but do not establish host acceptance.

No agent launching, transcripts, database actions, automatic worktrees, public previews, Compose management or multi-host orchestration.
