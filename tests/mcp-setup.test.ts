import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpSetup } from '../web/mcp-setup.js';
import { toolContracts } from '../src/shared/contracts.js';

test('MCP guide teaches installed local adapters and verification without credential examples', () => {
  const html = renderToStaticMarkup(React.createElement(McpSetup));
  assert(html.includes('codex mcp add rootlane -- /opt/stacks/rootlane/deploy/rootlane-mcp-docker'));
  assert(html.includes('claude mcp add --transport stdio --scope user rootlane -- /opt/stacks/rootlane/deploy/rootlane-mcp-docker'));
  for (const name of Object.keys(toolContracts)) assert(html.includes(`<code>${name}</code>`));
  assert(html.includes('Do not start or stop anything.'));
  assert(html.includes('does not currently expose a remote'));
  assert(!html.includes('ROOTLANE_AGENT_TOKEN'));
  assert(!html.includes('neo'));
  assert(html.includes('example Docker installation'));
  assert(!html.includes('dangerously-skip-permissions'));
  assert(html.includes('aria-label="Copy setup prompt"'));
  assert(html.indexOf('Register with Claude Code') < html.indexOf('Prefer agent-assisted setup?'));
  assert(html.includes('inspect any existing rootlane registration'));
  assert(html.includes('Never print or copy credentials.'));
  assert(html.includes('Do not install another backend'));
  assert(html.includes('report the blocker rather than replacing it'));
  assert(html.includes('read-only list_projects call if available'));
  assert(html.includes('normal approvals'));
});
