// After pnpm build: point PLAYWRIGHT_MODULE and CHROMIUM_BIN at installed browser tools.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer as httpsServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { EventEmitter } from 'node:events';
import { Config, EventBus, HostLinks, LaneManager, Store, buildServer, runCommand } from '../apps/daemon/dist/index.js';
import { SetupManager } from '../apps/daemon/dist/setup.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const cwd = resolve(fileURLToPath(new URL('../', import.meta.url)));
const until = async (fn) => { let last; for (let i = 0; i < 150; i++) { try { return await fn(); } catch (error) { last = error; await new Promise((r) => setTimeout(r, 100)); } } throw last; };
const loader = createRequire(join(cwd, 'package.json')).resolve('tsx');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_BIN,
  args: ['--no-sandbox', '--no-proxy-server', '--host-resolver-rules=MAP neo.test.ts.net 127.0.0.1'] });
try {
  for (const width of [1440, 390]) {
    const root = await mkdtemp(join(tmpdir(), 'cl-ssh-setup-'));
    const home = join(root, 'home'); const repo = join(home, 'code', `project-${process.pid}-${width}`);
    let app, proxy, store, hosts, context, lane, page;
    try {
      await mkdir(repo, { recursive: true });
      await runCommand('git', ['init', '-b', 'trunk', repo]);
      await runCommand('git', ['-c', 'user.name=ContextLanes', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture'], { cwd: repo });
      await runCommand('git', ['branch', 'feature'], { cwd: repo });
      await runCommand('git', ['checkout', 'feature'], { cwd: repo });
      await runCommand('git', ['update-ref', 'refs/remotes/origin/trunk', 'HEAD'], { cwd: repo });
      await runCommand('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], { cwd: repo });
      const key = join(root, 'key.pem'), cert = join(root, 'cert.pem');
      await runCommand('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=neo.test.ts.net', '-addext', 'subjectAltName=DNS:neo.test.ts.net', '-days', '1']);
      let address;
      const forwardedHeaders = (headers) => ({ ...headers, 'tailscale-user-login': 'fixture@example.invalid' });
      proxy = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
        const upstream = httpRequest(address + request.url, { method: request.method, headers: forwardedHeaders(request.headers) }, (result) => {
          response.writeHead(result.statusCode, result.headers); result.pipe(response);
        });
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        response.on('close', () => upstream.destroy()); request.pipe(upstream);
      });
      proxy.on('upgrade', (request, socket, head) => {
        const target = new URL(address);
        const upstream = connect({ host: '127.0.0.1', port: Number(target.port) }, () => {
          const headers = forwardedHeaders(request.headers);
          upstream.write(`GET ${request.url} HTTP/1.1\r\n` + Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n');
          if (head.length) upstream.write(head);
          socket.pipe(upstream).pipe(socket);
        });
        socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy());
      });
      await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const port = proxy.address().port;
      const publicUrl = `https://neo.test.ts.net:${port}`;
      let signedIn = false;
      const calls = [];
      const run = async (command, args, options) => {
        calls.push({ command, args });
        if (command === 'loginctl') return { stdout: 'no\n' };
        if (command === 'tailscale') {
          if (args[0] === 'status') return { stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'neo.test.ts.net.', UserID: 1 }, User: { '1': { LoginName: 'fixture@example.invalid' } } }) };
          if (args[1] === 'status') return { stdout: JSON.stringify({ TCP: { [port]: { HTTPS: true } }, Web: { [`neo.test.ts.net:${port}`]: { Handlers: { '/': { Proxy: address } } } } }) };
          throw new Error('The fixture must reuse its Serve route');
        }
        if (command === '/fixture/claude') { assert.deepEqual(args, ['auth', 'status', '--json']); return { stdout: JSON.stringify({ loggedIn: signedIn }) }; }
        return runCommand(command, args, options);
      };
      run.terminal = (command, args, options) => {
        assert.equal(command, '/fixture/claude'); assert.deepEqual(args, ['auth', 'login']);
        const events = new EventEmitter();
        setTimeout(() => events.emit('data', 'Press Enter to finish the fixture login.\r\n'), 25);
        return {
          write(data) { if (data.includes('\r')) { signedIn = true; events.emit('data', 'Signed in.\r\n'); events.emit('exit', { exitCode: 0 }); } },
          resize() {}, kill() {},
          onData(fn) { events.on('data', fn); return { dispose: () => events.off('data', fn) }; },
          onExit(fn) { events.on('exit', fn); return { dispose: () => events.off('exit', fn) }; },
        };
      };
      const configFile = join(root, 'config.toml');
      const config = Config.parse({ paths: { data: join(root, 'data'), lanes: join(root, 'lanes') },
        agents: { 'claude-code': { command: process.execPath, args: ['--import', loader, '--conditions=source', join(cwd, 'apps/lanehost/test/fixtures/fake-stdio.ts')] } } });
      await mkdir(config.paths.data); store = Store.open(join(config.paths.data, 'contextlanes.sqlite'));
      const bus = new EventBus(); hosts = new HostLinks({ store, bus }); await hosts.listen(join(config.paths.data, 'lanes.sock'));
      const lanes = new LaneManager({ store, bus, config, run });
      const setup = new SetupManager(config, store, run, { path: configFile, home, user: 'fixture',
        find: async (name) => name === 'claude' ? '/fixture/claude' : name === 'tailscale' ? '/fixture/tailscale' : name === process.execPath ? process.execPath : null,
        portFree: async () => true });
      await setup.initialize(); app = buildServer({ config, store, bus, hosts, lanes, setup, run, version: 'browser-fixture' });
      address = await app.listen({ host: '127.0.0.1', port: 0 }); config.listen.port = Number(new URL(address).port);
      const api = async (path) => { const result = await fetch(address + path); assert(result.ok, await result.clone().text()); return result.json(); };
      context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, ignoreHTTPSErrors: true });
      page = await context.newPage(); const errors = []; page.on('pageerror', (error) => { errors.push(error.message); console.error('Browser error:', error.message); });
      page.on('response', (response) => { if (response.status() >= 400) console.error('HTTP', response.status(), new URL(response.url()).pathname); });
      await page.goto(publicUrl + '/setup'); await page.getByRole('heading', { name: 'Open a sign-in link' }).waitFor();
      assert.equal(await page.getByLabel('Claim code', { exact: true }).count(), 0);
      const started = Date.now();
      const previousUrl = process.env.CONTEXTLANES_URL; process.env.CONTEXTLANES_URL = address;
      let cli;
      try { cli = await runCommand(process.execPath, [join(cwd, 'apps/cli/dist/main.js'), 'setup']); }
      finally { if (previousUrl === undefined) delete process.env.CONTEXTLANES_URL; else process.env.CONTEXTLANES_URL = previousUrl; }
      assert(cli.stdout.includes('sudo loginctl enable-linger fixture'));
      assert(cli.stdout.includes('single use; expires in 10 minutes')); assert(/[█▀▄]/.test(cli.stdout));
      const link = cli.stdout.match(/https:\/\/[^\s]+\/setup#signin=[\w-]{43}/)?.[0]; assert(link);
      assert(link.startsWith(publicUrl)); assert.equal(config.notifications.publicUrl, publicUrl);
      await page.goto(link);
      await page.getByRole('heading', { name: 'Agent', exact: true }).waitFor();
      assert.equal(await page.locator('input').count(), 0);
      assert(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled());
      assert.equal(await page.getByRole('button', { name: 'Add a passkey for this address' }).count(), 0);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM setup_link').get().n, 0);
      assert((await context.cookies()).some((cookie) => cookie.name === 'cl-owner' && cookie.httpOnly && cookie.secure));
      assert.equal(new URL(page.url()).hash, '');
      assert.equal(await page.getByRole('heading', { name: 'Local models', exact: true }).count(), 0);
      assert.equal(await page.getByRole('heading', { name: 'Phone notifications', exact: true }).count(), 0);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Connected · Follow' }).waitFor();
      await page.locator('.xterm-helper-textarea').press('Enter');
      await until(async () => assert(await page.getByRole('button', { name: 'Continue', exact: true }).isEnabled()));
      await page.getByRole('button', { name: 'Close login' }).click();
      assert((await page.locator('.setup-progress li').nth(0).innerText()).includes('Done'));
      await page.screenshot({ path: `/tmp/contextlanes-agent-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('heading', { name: 'Project', exact: true }).waitFor();
      await page.getByRole('checkbox', { name: `Select ${repo.split('/').at(-1)}` }).waitFor();
      assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 0);
      assert(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled());
      assert((await page.locator('.repo-choice').innerText()).includes('feature'));
      await page.screenshot({ path: `/tmp/contextlanes-project-${width}.png`, fullPage: true });
      await page.getByRole('checkbox', { name: `Select ${repo.split('/').at(-1)}` }).check();
      await page.getByRole('button', { name: 'Add selected projects', exact: true }).click();
      await until(async () => assert(await page.getByRole('button', { name: 'Continue', exact: true }).isEnabled()));
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page.getByRole('heading', { name: 'First lane', exact: true }).first().waitFor();
      await until(async () => assert.equal(await page.getByLabel('Base branch').inputValue(), 'trunk'));
      assert.equal(await page.getByLabel('Agent', { exact: true }).locator('option').count(), 1);
      assert.equal(await page.getByLabel('Agent', { exact: true }).inputValue(), 'claude-code');
      assert((await page.getByLabel('Task', { exact: true }).getAttribute('placeholder')).includes('/health'));
      await page.getByLabel('Task', { exact: true }).fill('permission');
      await page.screenshot({ path: `/tmp/contextlanes-first-lane-${width}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Start lane', exact: true }).click();
      await page.getByRole('button', { name: 'Allow once', exact: true }).waitFor();
      lane = store.listLanes()[0]; assert(lane); assert.equal(lane.state, 'needs_you');
      await page.getByRole('button', { name: 'Allow once', exact: true }).click();
      await until(async () => assert((await api(`/api/lanes/${lane.id}/events`)).some((event) => event.type === 'agent.message' && event.payload.text.includes('Finished permission'))));
      assert.equal(store.getLane(lane.id).state, 'working');
      const seconds = (Date.now() - started) / 1000; assert(seconds < 300);
      await page.goto(publicUrl + '/');
      await page.getByRole('heading', { name: 'Phone notifications', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Local models', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Public HTTPS app URL').inputValue(), publicUrl);
      assert.equal(await page.locator('details.notification-others').getAttribute('open'), null);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `/tmp/contextlanes-projects-after-lane-${width}.png`, fullPage: true });
      const cdp = await context.newCDPSession(page); await cdp.send('WebAuthn.enable');
      await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      await page.getByRole('button', { name: 'Add a passkey for this address', exact: true }).click();
      await until(async () => assert(config.access.passkey));
      assert.equal(config.access.passkey.rpId, 'neo.test.ts.net');
      const token = new URL(link).hash.slice(8);
      const replay = await page.evaluate(async (token) => (await fetch('/api/setup/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })).status, token);
      assert.equal(replay, 401);
      const persisted = await readFile(configFile, 'utf8'); assert(persisted.includes(publicUrl)); assert(persisted.includes('[access.passkey]'));
      assert(calls.some((call) => call.command === 'tailscale'));
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: CLI link/QR → fixed browser login → unchecked repo → default branch → running SDK fake lane in ${seconds.toFixed(1)}s; post-lane cards, HTTPS passkey and single-use replay verified. Tailscale was faked through Runner.`);
    } catch (error) {
      if (page) { console.error((await page.locator('body').innerText()).slice(0, 2500)); await page.screenshot({ path: `/tmp/contextlanes-setup-failure-${width}.png`, fullPage: true }); }
      throw error;
    } finally {
      await context?.close();
      for (const created of store?.listLanes() ?? []) { await runCommand('systemctl', ['--user', 'stop', `contextlanes-lane-${created.id.replace('/', '-')}`]).catch(() => {}); await runCommand('tmux', ['kill-session', '-t', created.terminal]).catch(() => {}); }
      await app?.close(); await hosts?.close(); store?.close();
      if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); }
      await rm(root, { recursive: true, force: true });
    }
  }
} finally { await browser.close(); }
