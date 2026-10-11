import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createServer } from '../src/http/server.js';
import { Catalog } from '../src/catalog/discovery.js';
import { Rootlane } from '../src/service.js';
import { toolContracts, catalogOutput } from '../src/shared/contracts.js';
import { setup, request } from './helpers.js';
import { z } from 'zod';

for (const era of ['legacy', 'modern'] as const) test(`stdio ${era}: real SDK discovery, calls, strict contracts and harmless disconnect`, { timeout: 20000 }, async t => {
  const { config, lifecycle, host } = await setup(t);
  host.agentObservations.agents = [{ id: 'a'.repeat(24), name: 'Codex', cwd: config.projectRoots[0] }];
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
  assert.equal(catalogOutput.parse(projects.structuredContent).projects[0].agents[0].source, 'detected process');
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
  assert.equal((await client.listTools()).tools.length, 15);
  assert(!(await client.callTool({ name: 'list_projects', arguments: { limit: 1 } })).isError);
  await app.close();
  const unavailable = await client.callTool({ name: 'list_projects', arguments: { limit: 1 } });
  assert(unavailable.isError); assert(JSON.stringify(unavailable).includes('BACKEND_UNAVAILABLE'));
});

test('stdio adapter distinguishes safe transport, timeout, response, approval and input failures', { timeout: 20000 }, async t => {
  const { writeFile } = await import('node:fs/promises');
  const { root } = await setup(t);
  const script = resolve(root, 'fault-adapter.mjs');
  await writeFile(script, `
    import {createMcpServer} from ${JSON.stringify(resolve('src/mcp/server.ts'))};
    import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/server/stdio'))};
    let step=0;
    const server=createMcpServer('http://127.0.0.1:9480','a'.repeat(40),async()=>{
      switch(step++) {
        case 0: throw new TypeError('SECRET transport exception');
        case 1: throw new DOMException('SECRET timeout','TimeoutError');
        case 2: return new Response('SECRET invalid JSON');
        case 3: return Response.json({unexpected:'SECRET schema'});
        case 4: return Response.json({message:'SECRET malformed error'},{status:500});
        case 5: return Response.json({code:'APPROVAL_REQUIRED',message:'Owner approval required',approvalUrl:'https://neo.example.ts.net/?approval=test'},{status:409});
        case 6: return Response.json({code:'ROUTE_CONFLICT',message:'HTTPS route belongs to another configuration'},{status:409});
        case 7: return new Response('SECRET '+ 'x'.repeat(512*1024));
        case 8: return new Response(new ReadableStream({start(controller){controller.error(new DOMException('SECRET body timeout','TimeoutError'));}}));
        default: return Response.json({projects:[],nextCursor:null,warnings:[],observedAt:new Date().toISOString()});
      }
    });
    await server.connect(new StdioServerTransport());
  `);
  const client = new Client({ name: 'fault-test', version: '1.0.0' }); t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', script], stderr: 'pipe' }));
  assert.match(client.getInstructions()!, /Observation is read-only/);
  for (const code of ['BACKEND_UNAVAILABLE', 'BACKEND_TIMEOUT', 'BACKEND_INVALID_RESPONSE', 'BACKEND_INVALID_RESPONSE', 'BACKEND_INVALID_RESPONSE', 'APPROVAL_REQUIRED', 'ROUTE_CONFLICT', 'BACKEND_INVALID_RESPONSE', 'BACKEND_TIMEOUT']) {
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    assert(result.isError); const text = JSON.stringify(result); assert(text.includes(code)); assert(!text.includes('SECRET'));
    if (code === 'APPROVAL_REQUIRED') assert(text.includes('approvalUrl'));
    if (code === 'ROUTE_CONFLICT') assert(text.includes('never overwrite unrelated routes'));
  }
  const invalid = await client.callTool({ name: 'locate', arguments: { path: 'relative' } });
  assert(invalid.isError); assert.match(JSON.stringify(invalid), /validation|INVALID_INPUT/i); assert(!JSON.stringify(invalid).includes('BACKEND_UNAVAILABLE'));
  assert(!(await client.callTool({ name: 'list_projects', arguments: {} })).isError);
});

test('stdio publication is independent, durable and safe across conflicts, unready upstreams and reconciliation', { timeout: 20000 }, async t => {
  const { randomUUID } = await import('node:crypto');
  const { config, lifecycle, host, root, store } = await setup(t);
  config.previewTargets = [{ id: 'independent', approved: true, projectPath: root, checkoutPath: root, serviceId: 'web', serviceName: 'Independent web', port: 19482, httpsPort: 19485, readiness: config.profiles[0].services[1].readiness }];
  config.profiles = [];
  host.listeners = async () => [{ address: '127.0.0.1', port: 19482, pid: 123, cwd: root, cgroup: null }];
  const service = new Rootlane(new Catalog(config, host), lifecycle); await service.publications.reconcile();
  t.after(() => service.publications.drain());
  const app = await createServer(config, service, { owner: 'o'.repeat(40), agent: 'a'.repeat(40) });
  await app.listen({ host: '127.0.0.1', port: 0 }); config.port = (app.server.address() as AddressInfo).port; t.after(() => app.close());
  const client = new Client({ name: 'publication-test', version: '1.0.0' }); t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', resolve('src/mcp/main.ts')], env: { PATH: process.env.PATH ?? '/usr/bin', ROOTLANE_URL: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, ROOTLANE_AGENT_TOKEN: 'a'.repeat(40) }, stderr: 'pipe' }));
  const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  for (const tool of (await client.listTools()).tools) {
    for (const field of Object.values(tool.inputSchema.properties ?? {})) assert.equal(typeof (field as { description?: string }).description, 'string');
  }
  const located = await call('locate', { path: root }); assert(!located.isError, JSON.stringify(located));
  await call('get_capabilities'); await call('get_project', { projectId: (located.structuredContent as { project: { id: string } }).project.id });
  assert.equal(host.starts, 0); assert.equal(store.listOperations(undefined, undefined, 20).length, 0);
  host.routesMap.set(19485, 'unrelated');
  const conflict = await call('publish_preview', { targetId: 'independent', requestId: randomUUID() }); assert(conflict.isError); assert(JSON.stringify(conflict).includes('ROUTE_CONFLICT')); assert.equal(host.routesMap.get(19485), 'unrelated'); host.routesMap.delete(19485);
  host.probe = async () => false;
  const failing = { targetId: 'independent', requestId: randomUUID() };
  const accepted = (await call('publish_preview', failing)).structuredContent as { previewId: string; operation: { id: string } };
  await service.publications.drain();
  const failed = await call('publish_preview', failing); assert(failed.isError); assert(JSON.stringify(failed).includes('UPSTREAM_UNREADY')); assert.equal((failed.structuredContent as typeof accepted).operation.id, accepted.operation.id);
  await call('unpublish_preview', { previewId: accepted.previewId, requestId: randomUUID() }); await service.publications.drain();
  host.probe = async () => true;
  const input = { targetId: 'independent', requestId: randomUUID() };
  const published = (await call('publish_preview', input)).structuredContent as typeof accepted; await service.publications.drain();
  const state = (await call('get_preview', { previewId: published.previewId })).structuredContent as { route: string; upstream: string; https: string };
  assert.equal(state.route, 'matching'); assert.equal(state.upstream, 'ready'); assert.equal(state.https, 'verified');
  await service.publications.reconcile();
  assert.equal(((await call('publish_preview', input)).structuredContent as typeof accepted).operation.id, published.operation.id);
  await call('unpublish_preview', { previewId: published.previewId, requestId: randomUUID() }); await service.publications.drain();
  assert.equal(host.starts, 0); assert.equal(host.stops.length, 0); assert.equal((await host.listeners()).length, 1); assert.equal(host.routesMap.size, 0);
});
