import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createServer } from '../src/http/server.js';
import { Catalog } from '../src/catalog/discovery.js';
import { Rootlane } from '../src/service.js';
import { toolContracts } from '../src/shared/contracts.js';
import { setup, request } from './helpers.js';
import { z } from 'zod';

for (const era of ['legacy', 'modern'] as const) test(`stdio ${era}: real SDK discovery, calls, strict contracts and harmless disconnect`, { timeout: 20000 }, async t => {
  const { config, lifecycle, host } = await setup(t);
  const app = await createServer(config, new Rootlane(new Catalog(config, host), lifecycle), { owner: 'o'.repeat(40), agent: 'a'.repeat(40) });
  await app.listen({ host: '127.0.0.1', port: 0 }); config.port = (app.server.address() as AddressInfo).port; t.after(() => app.close());
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('src/mcp/main.ts')], env: { PATH: process.env.PATH ?? '/usr/bin', ROOTLANE_URL: `http://127.0.0.1:${config.port}`, ROOTLANE_AGENT_TOKEN: 'a'.repeat(40) }, stderr: 'pipe' });
  const client = new Client({ name: 'rootlane-test', version: '1.0.0' }, { versionNegotiation: { mode: era === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } });
  t.after(() => client.close()); await client.connect(transport); assert.equal(client.getProtocolEra(), era);
  const listing = await client.listTools(); assert.deepEqual(listing.tools.map(t => t.name).sort(), Object.keys(toolContracts).sort());
  for (const tool of listing.tools) {
    const contract = toolContracts[tool.name as keyof typeof toolContracts];
    assert.equal(tool.inputSchema.additionalProperties, false); assert(tool.outputSchema); assert.equal(tool.annotations?.readOnlyHint, contract.read);
    const expected = z.toJSONSchema(contract.input, { io: 'input' }); assert.deepEqual(tool.inputSchema.properties, expected.properties);
  }
  const projects = await client.callTool({ name: 'list_projects', arguments: { limit: 1 } }); assert(!projects.isError);
  const payload = request(); const started = await client.callTool({ name: 'start_environment', arguments: payload }); assert(!started.isError);
  const again = await client.callTool({ name: 'start_environment', arguments: payload }); assert.deepEqual(again.structuredContent && (again.structuredContent as { operation: { id: string } }).operation.id, started.structuredContent && (started.structuredContent as { operation: { id: string } }).operation.id);
  await client.close(); await lifecycle.drain(); assert.equal(host.units.size, 2);
});
