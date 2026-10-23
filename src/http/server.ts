import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Rootlane } from '../service.js';
import { approvalsOutput, toolContracts, problem, Problem, id, locateInput, environmentInspection, type ToolName } from '../shared/contracts.js';
import { recipeSchema } from '../recipes.js';
import { telemetrySetup } from '../telemetry/setup.js';
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loginSchema = z.strictObject({ credential: z.string().min(1).max(256) });
export async function createServer(config: Config, service: Rootlane, credentials: { owner: string; agent: string; ingest?: string }, webRoot?: string) {
  if (!credentials.owner.trim() || credentials.owner.length > 256 || credentials.agent.length < 32 || equal(credentials.owner, credentials.agent))
    throw new Error('A nonempty owner credential of at most 256 characters and a distinct agent credential of at least 32 characters are required');
  if (credentials.ingest && (credentials.ingest.length < 32 || credentials.ingest.length > 256 || equal(credentials.ingest, credentials.owner) || equal(credentials.ingest, credentials.agent)))
    throw new Error('The ingest credential must be distinct from owner and agent credentials, with 32–256 characters');
  const app = Fastify({ logger: false, bodyLimit: 16384, requestTimeout: 10000, connectionTimeout: 10000, keepAliveTimeout: 5000 });
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const cookieName = '__Host-rootlane';
  const origins = new Set([config.origin, ...(config.additionalOrigins ?? [])]);
  const hosts = new Set([...origins].map((origin) => new URL(origin).host));
  const loopback = () => `127.0.0.1:${config.port}`;
  const browserOrigin = (host: string | undefined, origin: string | undefined) =>
    origin !== undefined && origins.has(origin) && (host === loopback() || new URL(origin).host === host);
  const session = (cookie: string | undefined) => {
    const token = cookie
      ?.split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const found = token ? sessions.get(token) : undefined;
    return found && found.expires > Date.now() ? found : undefined;
  };
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Cache-Control', 'no-store')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (!request.headers.host || !(hosts.has(request.headers.host) || request.headers.host === loopback()))
      return reply.code(403).send({ code: 'INVALID_HOST', message: 'Unexpected Host' });
    if (request.headers.origin !== undefined && !browserOrigin(request.headers.host, request.headers.origin))
      return reply.code(403).send({ code: 'INVALID_ORIGIN', message: 'Unexpected Origin' });
    const path = request.routeOptions.url;
    if (credentials.ingest && equal(request.headers.authorization ?? '', `Bearer ${credentials.ingest}`))
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'The ingest credential is accepted only by the telemetry receiver' });
    if (path === '/api/login') {
      if (request.method !== 'POST') return;
      if (!browserOrigin(request.headers.host, request.headers.origin))
        return reply.code(403).send({ code: 'INVALID_ORIGIN', message: 'Use the configured HTTPS origin' });
      if (session(request.headers.cookie)) return;
      const budget = service.lifecycle.store.consumeLoginAttempt();
      const retryAfter = Math.max(budget, service.lifecycle.store.loginBackoff());
      if (retryAfter)
        return reply
          .header('Retry-After', retryAfter)
          .code(429)
          .send({ code: 'RATE_LIMIT', message: 'Too many login attempts; wait before trying again' });
      return;
    }
    if (!path?.startsWith('/api/')) return;
    const auth = request.headers.authorization;
    if (auth !== undefined) {
      if (path.startsWith('/api/approvals') || path.startsWith('/api/owner/') || path === '/api/telemetry/copy')
        return reply.code(403).send({ code: 'OWNER_SESSION_REQUIRED', message: 'This action requires an owner cookie session and CSRF' });
      if (request.ip !== '127.0.0.1' || !equal(auth, `Bearer ${credentials.agent}`))
        return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid loopback agent credential required' });
      return;
    }
    const current = session(request.headers.cookie);
    if (!current) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Unlock Rootlane with the installation owner credential' });
    if (
      !['GET', 'HEAD'].includes(request.method) &&
      (!browserOrigin(request.headers.host, request.headers.origin) || request.headers['x-rootlane-csrf'] !== current.csrf)
    )
      return reply.code(403).send({ code: 'CSRF_REJECTED', message: 'Refresh this page before retrying' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Request does not match the strict tool schema' });
    if (error instanceof Problem) return reply.code(error.code === 'NOT_FOUND' ? 404 : 409).send(problem(error));
    const status = (error as { statusCode?: number }).statusCode;
    return reply
      .code(status && status >= 400 && status < 500 ? status : 500)
      .send({ code: 'REQUEST_FAILED', message: 'Request failed; check service availability and request limits' });
  });
  app.post('/api/login', async (request, reply) => {
    const { credential } = loginSchema.parse(request.body);
    if (!equal(credential, credentials.owner)) {
      if (!session(request.headers.cookie)) service.lifecycle.store.loginFailed();
      return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid owner credential' });
    }
    if (!session(request.headers.cookie)) service.lifecycle.store.loginSucceeded();
    for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
    if (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    sessions.set(token, { csrf, expires: Date.now() + 8 * 3600000 });
    reply.header('Set-Cookie', `${cookieName}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    return { csrf };
  });
  app.get('/api/session', async (request) => ({ csrf: session(request.headers.cookie)?.csrf ?? null }));
  app.get('/api/status', async () => ({
    connected: true,
    version: '0.9.0',
    editorUrlTemplate: config.editorUrlTemplate ?? null,
    projectRoots: service.catalog.config.projectRoots,
    observationRoots: service.catalog.config.observationRoots,
    lifecycleAvailable: !service.reconciling,
    reconciling: service.reconciling,
    lastError: service.lastError,
    configError: service.configError,
    tailscale: await service.lifecycle.host.connection(),
    observedAt: new Date().toISOString(),
  }));
  app.get('/api/approvals', async () => approvalsOutput.parse({ approvals: await service.recipes.listApprovals() }));
  app.post('/api/owner/configuration', async request=>{
    const input = locateInput.extend({recipe:recipeSchema,tools:z.partialRecord(z.enum(['node','python','venv']),z.string().startsWith('/').max(4096).refine(v=>!/[\0\r\n]/.test(v))),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.body);
    return environmentInspection.parse(await service.recipes.configure(input.path,input.recipe,input.tools,input.fingerprint));
  });
  app.post('/api/owner/preparation', async request=>{
    const input = locateInput.extend({fingerprint:z.string().regex(/^[a-f0-9]{64}$/),requestId:z.uuid()}).parse(request.body);
    return service.recipes.runPreparation(input.path,input.fingerprint,input.requestId);
  });
  app.post('/api/owner/preparation/:id/cleanup', async request=>service.recipes.cleanupPreparation(z.strictObject({id:z.uuid()}).parse(request.params).id));
  app.post('/api/owner/retirement', async request=>service.recipes.retire(z.strictObject({environmentId:id}).parse(request.body).environmentId));
  app.post('/api/owner/recovery-policy', async request=>{
    const {environmentId,restore} = z.strictObject({environmentId:id,restore:z.boolean()}).parse(request.body);
    return service.recoveryPolicy(environmentId,restore);
  });
  app.post('/api/owner/export-recipe', async request=>{
    const inspection = await service.recipes.inspectEnvironment(locateInput.parse(request.body).path);
    if (!inspection.proposal) throw new Problem('NOT_FOUND','No recipe to export');
    return {recipe:inspection.proposal};
  });
  app.post('/api/owner/integrations', async request=>service.integrations.run(z.strictObject({client:z.enum(['codex','claude']),action:z.enum(['inspect','apply','verify']),fingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),telemetry:z.boolean().optional(),replaceExporters:z.boolean().optional()}).parse(request.body),credentials.ingest ?? ''));
  app.post('/api/owner/telemetry-policy', async request=>{
    const {enabled}=z.strictObject({enabled:z.boolean()}).parse(request.body);
    if(enabled && !credentials.ingest)throw new Problem('INGEST_CREDENTIAL_UNSET','Generate an ingest credential through owner setup first');
    await service.telemetry.reconfigure({...config.telemetry,enabled},credentials.ingest);
    config.telemetry.enabled=enabled;service.lifecycle.store.setMeta('telemetryEnabled',String(enabled));
    if(!enabled)await service.telemetry.purge();
    return {enabled};
  });
  app.post('/api/telemetry/copy', async (request) => {
    const { kind } = z.strictObject({ kind: z.enum(['credential','claude-env','hooks','statusline','codex']) }).parse(request.body);
    if (!credentials.ingest) throw new Problem('INGEST_CREDENTIAL_UNSET', 'Run owner setup to generate the ingest credential');
    return { value: telemetrySetup(kind, config, credentials.ingest) };
  });
  for (const action of ['approve', 'reject'] as const)
    app.post(`/api/approvals/:id/${action}`, async (request) => {
      const approvalId = z.strictObject({ id: z.uuid() }).parse(request.params).id;
      z.strictObject({}).parse(request.body);
      return service.recipes.decide(approvalId, action === 'approve');
    });
  for (const name of Object.keys(toolContracts) as ToolName[]) app.post(`/api/tools/${name}`, async (request) => {
    const parent = request.headers['x-rootlane-parent-pid'];
    const pid = request.headers.authorization !== undefined && typeof parent === 'string' && /^[1-9]\d{0,9}$/.test(parent) && Number(parent) <= 2147483647 ? Number(parent) : null;
    let failed = true;
    try {
      const result = await service.call(name, request.body);
      failed = 'operation' in result && result.operation.error !== null;
      return result;
    } finally {
      if (pid) service.telemetry.recordRootlaneCall(pid, name, failed);
    }
  });
  if (webRoot) {
    const index = await readFile(join(webRoot, 'index.html'));
    app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(index));
    // Only built assets are served; never expose arbitrary checkout files.
    const files = await readdir(join(webRoot, 'assets'));
    for (const file of files) {
      if (!/^[a-zA-Z0-9_.-]+\.(js|css|woff2)$/.test(file)) continue;
      const data = await readFile(join(webRoot, 'assets', file));
      app.get(`/assets/${file}`, async (_request, reply) =>
        reply
          .type(file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.woff2') ? 'font/woff2' : 'text/css; charset=utf-8')
          .send(data),
      );
    }
  }
  return app;
}
