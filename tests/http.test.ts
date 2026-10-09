import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/http/server.js';
import { Catalog } from '../src/catalog/discovery.js';
import { Rootlane } from '../src/service.js';
import { setup, request } from './helpers.js';

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
