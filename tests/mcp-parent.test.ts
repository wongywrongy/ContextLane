import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { agentSessionsOutput } from '../src/shared/contracts.js';

test('stdio MCP forwards only a valid owner-process PID with each backend request', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rootlane-mcp-parent-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [pid, expected] of [[9876, '9876'], [0, 'absent'], [2147483648, 'absent']] as const) {
    const script = join(root, `adapter-${pid}.mjs`);
    await writeFile(script, `
      import { createMcpServer } from ${JSON.stringify(resolve('src/mcp/server.ts'))};
      import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
      const server = createMcpServer('http://127.0.0.1:9480', 'a'.repeat(40), async (_url, init) => Response.json({ projects: [], nextCursor: null, warnings: [new Headers(init.headers).get('x-rootlane-parent-pid') ?? 'absent'], observedAt: new Date().toISOString() }), ${pid});
      await server.connect(new StdioServerTransport());
    `);
    const client = new Client({ name: 'pid-forwarding-test', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', script], stderr: 'pipe' }));
      for (let call = 0; call < 2; call++) {
        const result = await client.callTool({ name: 'list_projects', arguments: {} });
        assert(!result.isError); assert.deepEqual((result.structuredContent as { warnings: string[] }).warnings, [expected]);
      }
    } finally { await client.close(); }
  }
});

test('MCP accepts complete counts-only session aggregates above 512KiB and keeps other tools bounded', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'rootlane-mcp-aggregate-')); t.after(() => rm(root, { recursive: true, force: true }));
  const at = new Date().toISOString();
  const aggregate = agentSessionsOutput.parse({
    sessions: Array.from({ length: 32 }, (_, index) => ({
      id: `claude:session-${index}`, agent: 'claude', sessionKey: `session-${index}`, pid: 1000 + index, cwd: null, projectId: 'project',
      match: 'Matched', model: 'claude-opus', effort: 'high', mode: 'default', startedAt: at, lastSeenAt: at, endedAt: null,
      counters: { 'tokens.input': 15000, 'tokens.output': 1000, requests: 10 },
      tools: Array.from({ length: 200 }, (_, tool) => ({ tool: `tool_${tool}_${'named_tool_'.repeat(9)}`, calls: tool + 1, failures: 0, rejects: 0, totalMs: 1500, p95Ms: 150 })),
      toolkit: [], context: null, requestLatency: { p50Ms: 100, p95Ms: 200 }, rootlaneTools: [],
    })),
    telemetry: { enabled: true, receiving: true, lastEventAt: at, dropped: 0 },
  });
  assert(Buffer.byteLength(JSON.stringify(aggregate)) > 512 * 1024);
  const script = join(root, 'aggregate-adapter.mjs');
  await writeFile(script, `
    import { createMcpServer } from ${JSON.stringify(resolve('src/mcp/server.ts'))};
    import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
    const aggregate = ${JSON.stringify(aggregate)};
    const server = createMcpServer('http://127.0.0.1:9480', 'a'.repeat(40), async url => url.pathname.endsWith('/get_agent_sessions') ? Response.json(aggregate) : new Response('x'.repeat(512 * 1024 + 1)));
    await server.connect(new StdioServerTransport());
  `);
  const client = new Client({ name: 'session-aggregate-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', script], stderr: 'pipe' }));
    const result = await client.callTool({ name: 'get_agent_sessions', arguments: { projectId: 'project' } });
    assert(!result.isError); assert.deepEqual(result.structuredContent, aggregate);
    const oversized = await client.callTool({ name: 'list_projects', arguments: {} });
    assert(oversized.isError); assert.match(JSON.stringify(oversized), /BACKEND_INVALID_RESPONSE/);
  } finally { await client.close(); }
});
