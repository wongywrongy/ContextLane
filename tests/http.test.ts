import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http/server.js';
import { Catalog } from '../src/catalog/discovery.js';
import { Rootlane } from '../src/service.js';
import { setup, request } from './helpers.js';
import { Store } from '../src/state/store.js';
import { Lifecycle } from '../src/lifecycle/service.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

test('owner-selected short credentials work while empty owner and weak/shared agent credentials fail', async t => {
  const { config, lifecycle, host } = await setup(t);
  const service = new Rootlane(new Catalog(config, host), lifecycle);
  const agent = 'a'.repeat(40);
  for (const credentials of [{ owner: '', agent }, { owner: '   ', agent }, { owner: 'x'.repeat(257), agent }, { owner: 'chosen', agent: 'short' }, { owner: agent, agent }]) {
    await assert.rejects(createServer(config, service, credentials), /credential/);
  }
  const app = await createServer(config, service, { owner: 'chosen', agent }); t.after(() => app.close());
  const headers = { host: new URL(config.origin).host, origin: config.origin };
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', headers, payload: { credential: '' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', headers, payload: { credential: 'wrong' } })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/api/login', headers, payload: { credential: 'chosen' } });
  assert.equal(login.statusCode, 200);
  assert.match(String(login.headers['set-cookie']), /Secure; HttpOnly; SameSite=Strict/);
});

test('HTTP rejects unauthorized, host/origin, CSRF and extra fields; session and agent credentials remain separate', async t => {
  const { config, lifecycle, host } = await setup(t);
  const app = await createServer(config, new Rootlane(new Catalog(config, host), lifecycle), { owner: 'o'.repeat(40), agent: 'a'.repeat(40) }); t.after(() => app.close());
  const path = '/api/tools/start_environment'; const payload = request(); const origin = config.origin; const hostname = new URL(origin).host;
  const anonymous = await app.inject({ method: 'POST', url: path, headers: { host: hostname }, payload }); assert.equal(anonymous.statusCode, 401);
  const bearer = { host: `127.0.0.1:${config.port}`, authorization: `Bearer ${'a'.repeat(40)}` };
  assert.equal((await app.inject({ method: 'POST', url: path, headers: { ...bearer, host: 'evil.test' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: path, headers: { ...bearer, origin: 'https://evil.test' }, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: path, headers: { ...bearer, authorization: `Bearer ${'o'.repeat(40)}` }, payload })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: path, headers: bearer, payload: { ...payload, command: 'touch /tmp/unwanted' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tools/get_logs', headers: bearer, payload: { environmentId: 'fixture', serviceId: 'api', limit: 101 } })).statusCode, 400);
  const login = await app.inject({ method: 'POST', url: '/api/login', headers: { host: hostname, origin }, payload: { credential: 'o'.repeat(40) } }); assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']); assert.match(cookie, /Secure; HttpOnly; SameSite=Strict/);
  const sessionHeaders = { host: hostname, origin, cookie: cookie.split(';')[0] };
  assert.equal((await app.inject({ method: 'POST', url: path, headers: sessionHeaders, payload })).statusCode, 403);
  const start = await app.inject({ method: 'POST', url: path, headers: { ...sessionHeaders, 'x-rootlane-csrf': login.json().csrf }, payload }); assert.equal(start.statusCode, 200); assert.equal(start.json().operation.status, 'accepted');
  const retry = await app.inject({ method: 'POST', url: path, headers: bearer, payload }); assert.equal(retry.json().operation.id, start.json().operation.id);
  await lifecycle.drain();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 9 * 3600000 });
  assert.equal((await app.inject({ method: 'GET', url: '/api/session', headers: sessionHeaders })).statusCode, 401);
  t.mock.timers.reset();
});


test('reviewed HTTPS alias supports owner sessions and CSRF while rejecting cross-origin Host pairs', async t => {
  const { config, lifecycle, host } = await setup(t);
  config.additionalOrigins = ['https://root.avlis.dev'];
  const app = await createServer(config, new Rootlane(new Catalog(config, host), lifecycle), { owner: 'o'.repeat(40), agent: 'a'.repeat(40) }); t.after(() => app.close());
  const headers = { host: 'root.avlis.dev', origin: 'https://root.avlis.dev' };
  const login = await app.inject({ method: 'POST', url: '/api/login', headers, payload: { credential: 'o'.repeat(40) } });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const request = { method: 'POST' as const, url: '/api/tools/list_projects', payload: { limit: 1 } };
  assert.equal((await app.inject({ ...request, headers: { ...headers, cookie } })).statusCode, 403);
  const authorized = { ...headers, cookie, 'x-rootlane-csrf': login.json().csrf };
  assert.equal((await app.inject({ ...request, headers: authorized })).statusCode, 200);
  assert.equal((await app.inject({ ...request, headers: { ...authorized, origin: config.origin } })).statusCode, 403);
  assert.equal((await app.inject({ ...request, headers: { ...authorized, host: 'evil.test' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/login', headers: { host: new URL(config.origin).host, origin: config.origin }, payload: { credential: 'o'.repeat(40) } })).statusCode, 200);
});

test('login limit is shared across aliases and spoofed IPs, survives restart, and recovers after a sliding minute', async t => {
  const { root, config, lifecycle, host } = await setup(t);
  config.additionalOrigins = ['https://root.avlis.dev'];
  const credentials = { owner: 'o'.repeat(40), agent: 'a'.repeat(40) };
  let app = await createServer(config, new Rootlane(new Catalog(config, host), lifecycle), credentials);
  t.after(() => app.close());
  const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
  let address = 0;
  const login = (credential = 'wrong'.repeat(10), alias = false, url = '/api/login') => app.inject({ method: 'POST', url, headers: { host: alias ? 'root.avlis.dev' : new URL(config.origin).host, origin: alias ? config.additionalOrigins![0] : config.origin, 'x-forwarded-for': `198.51.100.${++address}` }, payload: { credential } });
  const failures = await Promise.all(Array.from({ length: 10 }, (_, i) => login(undefined, i % 2 === 0)));
  assert(failures.every(response => response.statusCode === 401));
  const blocked = await login(credentials.owner, true, '/api/login?retry=1');
  assert.equal(blocked.statusCode, 429); assert.equal(blocked.headers['retry-after'], '60');
  assert.equal(blocked.headers['set-cookie'], undefined);
  for (const url of ['/api/%6cogin', '/%61pi/login', '/api/login/']) {
    const alternate = await login(credentials.owner, false, url);
    assert([404, 429].includes(alternate.statusCode), `${url} must not bypass the login limit`);
  }
  await app.close();
  const reopened = new Store(join(root, 'state.sqlite')); t.after(() => reopened.close());
  app = await createServer(config, new Rootlane(new Catalog(config, host), new Lifecycle(config, reopened, host)), credentials);
  assert.equal((await login(credentials.owner)).statusCode, 429);
  t.mock.timers.setTime(now + 59000);
  assert.equal((await login()).headers['retry-after'], '1');
  t.mock.timers.setTime(now + 60000);
  const accepted = await login(credentials.owner); assert.equal(accepted.statusCode, 200);
  const cookie = String(accepted.headers['set-cookie']).split(';')[0];
  await Promise.all(Array.from({ length: 9 }, () => login()));
  assert.equal((await login()).statusCode, 429);
  assert.equal((await app.inject({ url: '/api/session', headers: { host: new URL(config.origin).host, cookie } })).statusCode, 200, 'throttling does not lock out existing sessions');
  assert(!reopened.meta('loginAttempts')!.includes(credentials.owner));
});

test('malformed and oversized login bodies consume the same bounded login budget before parsing', async t => {
  const { config, lifecycle, host } = await setup(t);
  const app = await createServer(config, new Rootlane(new Catalog(config, host), lifecycle), { owner: 'o'.repeat(40), agent: 'a'.repeat(40) }); t.after(() => app.close());
  const headers = { host: new URL(config.origin).host, origin: config.origin, 'content-type': 'application/json' };
  const login = (payload: string) => app.inject({ method: 'POST', url: '/api/login', headers, payload });
  assert.equal((await login('{')).statusCode, 400);
  assert.equal((await login(JSON.stringify({ credential: 'x'.repeat(20000) }))).statusCode, 413);
  assert.equal((await login(JSON.stringify({ credential: 'x'.repeat(40), extra: true }))).statusCode, 400);
  for (let i = 0; i < 7; i++) assert.equal((await login(JSON.stringify({ credential: 'x'.repeat(40) }))).statusCode, 401);
  assert.equal((await login('{')).statusCode, 429);
});


test('built font assets have the right MIME type and arbitrary files remain inaccessible', async t => {
  const { root, config, lifecycle, host } = await setup(t);
  const web = join(root, 'web'); await mkdir(join(web, 'assets'), { recursive: true });
  await writeFile(join(web, 'index.html'), '<h1>Rootlane</h1>');
  await writeFile(join(web, 'assets', 'font-test.woff2'), Buffer.from([1,2,3,4]));
  await writeFile(join(web, 'assets', 'private.env'), 'not a built asset');
  const app = await createServer(config, new Rootlane(new Catalog(config, host), lifecycle), { owner: 'chosen', agent: 'a'.repeat(40) }, web); t.after(() => app.close());
  const headers = { host: new URL(config.origin).host };
  const font = await app.inject({ url: '/assets/font-test.woff2', headers });
  assert.equal(font.statusCode, 200); assert.equal(font.headers['content-type'], 'font/woff2');
  assert.equal((await app.inject({ url: '/assets/private.env', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/assets/../private.env', headers })).statusCode, 404);
});
