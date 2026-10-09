import Fastify from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Rootlane } from '../service.js';
import { toolContracts, problem, Problem, type ToolName } from '../shared/contracts.js';
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loginSchema = z.strictObject({ credential: z.string().min(32).max(256) });
export async function createServer(config: Config, service: Rootlane, credentials: { owner: string; agent: string }, webRoot?: string) {
  if (credentials.owner.length < 32 || credentials.agent.length < 32 || equal(credentials.owner, credentials.agent)) throw new Error('Distinct owner and agent credentials of at least 32 characters are required');
  const app = Fastify({ logger: false, bodyLimit: 16384, requestTimeout: 10000, connectionTimeout: 10000, keepAliveTimeout: 5000 });
  const sessions = new Map<string, { csrf: string; expires: number }>();
  let loginWindow = Date.now(); let attempts = 0;
  const cookieName = '__Host-rootlane';
  const session = (cookie: string | undefined) => {
    const token = cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const found = token ? sessions.get(token) : undefined;
    return found && found.expires > Date.now() ? found : undefined;
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store').header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!request.headers.host || ![new URL(config.origin).host, `127.0.0.1:${config.port}`].includes(request.headers.host)) return reply.code(403).send({ code: 'INVALID_HOST', message: 'Unexpected Host' });
    if (request.headers.origin !== undefined && request.headers.origin !== config.origin) return reply.code(403).send({ code: 'INVALID_ORIGIN', message: 'Unexpected Origin' });
    if (!request.url.startsWith('/api/') || request.url.split('?')[0] === '/api/login') return;
    const auth = request.headers.authorization;
    if (auth !== undefined) {
      if (request.ip !== '127.0.0.1' || !equal(auth, `Bearer ${credentials.agent}`)) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Valid loopback agent credential required' });
      return;
    }
    const current = session(request.headers.cookie);
    if (!current) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Unlock Rootlane with the installation owner credential' });
    if (!['GET', 'HEAD'].includes(request.method) && (request.headers.origin !== config.origin || request.headers['x-rootlane-csrf'] !== current.csrf)) return reply.code(403).send({ code: 'CSRF_REJECTED', message: 'Refresh this page before retrying' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Request does not match the strict tool schema' });
    if (error instanceof Problem) return reply.code(error.code === 'NOT_FOUND' ? 404 : 409).send(problem(error));
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status >= 400 && status < 500 ? status : 500).send({ code: 'REQUEST_FAILED', message: 'Request failed; check service availability and request limits' });
  });
  app.post('/api/login', async (request, reply) => {
    if (request.headers.origin !== config.origin) return reply.code(403).send({ code: 'INVALID_ORIGIN', message: 'Use the configured HTTPS origin' });
    if (Date.now() - loginWindow > 60000) { loginWindow = Date.now(); attempts = 0; }
    if (++attempts > 10) return reply.code(429).send({ code: 'RATE_LIMIT', message: 'Wait a minute before trying again' });
    const { credential } = loginSchema.parse(request.body);
    if (!equal(credential, credentials.owner)) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Invalid owner credential' });
    for (const [key, value] of sessions) if (value.expires <= Date.now()) sessions.delete(key);
    if (sessions.size >= 8) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url'); const csrf = randomBytes(32).toString('base64url');
    sessions.set(token, { csrf, expires: Date.now() + 8 * 3600000 });
    reply.header('Set-Cookie', `${cookieName}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    return { csrf };
  });
  app.get('/api/session', async request => ({ csrf: session(request.headers.cookie)?.csrf ?? null }));
  app.get('/api/status', async () => ({ connected: true, lifecycleAvailable: service.lifecycle.available, tailscale: await service.lifecycle.host.connection(), observedAt: new Date().toISOString() }));
  for (const name of Object.keys(toolContracts) as ToolName[]) app.post(`/api/tools/${name}`, async request => service.call(name, request.body));
  if (webRoot) {
    const index = await readFile(join(webRoot, 'index.html'));
    app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(index));
    // Only built assets are served; never expose arbitrary checkout files.
    const files = await readdir(join(webRoot, 'assets'));
    for (const file of files) {
      if (!/^[a-zA-Z0-9_.-]+\.(js|css)$/.test(file)) continue;
      const data = await readFile(join(webRoot, 'assets', file));
      app.get(`/assets/${file}`, async (_request, reply) => reply.type(file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8').send(data));
    }
  }
  return app;
}
