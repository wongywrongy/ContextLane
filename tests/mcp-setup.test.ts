import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { McpSetup } from '../web/mcp-setup.js';
import { toolContracts } from '../src/shared/contracts.js';
import { readFile } from 'node:fs/promises';

test('Codex example exposes every current workflow tool with approval prompts', async () => {
  const config = await readFile('deploy/codex-mcp.example.toml', 'utf8');
  const allowlist = JSON.parse(config.match(/^enabled_tools = (\[[^\n]+\])/m)![1]);
  assert.deepEqual(allowlist.sort(), Object.keys(toolContracts).sort());
  assert.match(config, /default_tools_approval_mode = "prompt"/);
});

test('integration UI distinguishes registration, connection and tool verification without credentials', () => {
  const html = renderToStaticMarkup(React.createElement(McpSetup));
  for (const name of Object.keys(toolContracts)) assert(html.includes(`<code>${name}</code>`));
  for (const text of ['Inspect integration','Configured, Connection checked and Tool call verified','Do not start or stop anything.','does not currently expose a remote','Normal client approvals','list_mcp_resources is not a connection test']) assert(html.includes(text),text);
  assert(!html.includes('ROOTLANE_AGENT_TOKEN'));
  assert(!html.includes('dangerously-skip-permissions'));
});
