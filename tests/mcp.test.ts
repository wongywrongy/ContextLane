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

test('native wrapper resolves a relocated release and configured port, keeps stdin clean and fails without a backend', { timeout: 20000 }, async t => {
  const { mkdir, copyFile, writeFile, symlink } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const { config, lifecycle, host } = await setup(t);
  const app = await createServer(config, new Rootlane(new Catalog(config, host), lifecycle), { owner: 'o'.repeat(40), agent: 'a'.repeat(40) });
  await app.listen({ host: '127.0.0.1', port: 0 }); t.after(() => app.close());
  const port = (app.server.address() as AddressInfo).port; config.port = port;
  const release = join(config.projectRoots[0], 'relocated release');
  await mkdir(join(release, 'deploy'), { recursive: true });
  await copyFile('deploy/rootlane-mcp', join(release, 'deploy/rootlane-mcp'));
  await symlink(resolve('dist'), join(release, 'dist'));
  const settings = join(release, 'owner-config.json'), credential = join(release, 'agent.credential');
  await writeFile(settings, JSON.stringify({ port }), { mode: 0o600 });
  await writeFile(credential, 'a'.repeat(40), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: '/bin/sh', args: [join(release, 'deploy/rootlane-mcp')], env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, ROOTLANE_CONFIG: settings, ROOTLANE_AGENT_CREDENTIAL_FILE: credential }, stderr: 'pipe' });
  const client = new Client({ name: 'native-wrapper-test', version: '1.0.0' }); t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 5);
  assert(!(await client.callTool({ name: 'list_projects', arguments: { limit: 1 } })).isError);
  await app.close();
  const unavailable = await client.callTool({ name: 'list_projects', arguments: { limit: 1 } });
  assert(unavailable.isError); assert(JSON.stringify(unavailable).includes('BACKEND_UNAVAILABLE'));
});
