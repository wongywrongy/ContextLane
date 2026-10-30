// After pnpm build: real systemd units, a throwaway fixture repo and Chromium at both widths.
// PLAYWRIGHT_MODULE and CHROMIUM_BIN point at installed browser tools; OUT keeps the screenshots.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Config, EventBus, HostLinks, LaneManager, Runtime, Store, buildServer, runCommand } from '../apps/daemon/dist/index.js';
import { SetupManager } from '../apps/daemon/dist/setup.js';

const exec = promisify(execFile);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const out = process.env.OUT ?? tmpdir();
const root = await mkdtemp(join(tmpdir(), 'cl-phase2-'));
const repo = join(root, 'billing'), lanes = join(root, 'lanes');
const git = (...args) => exec('git', ['-c', 'user.name=CL', '-c', 'user.email=cl@example.invalid', ...args], { cwd: repo });
const SERVER = `const http = require("node:http"); console.log("listening"); http.createServer((req, res) => { console.log(req.method, req.url, 200); res.setHeader("content-type", "text/html"); res.end("<h1>Billing</h1>"); }).listen(Number(process.env.PORT), process.env.HOST);`;

await mkdir(repo, { recursive: true });
await git('init', '-b', 'main');
await writeFile(join(repo, '.gitignore'), '.env*\nnode_modules\n');
await writeFile(join(repo, 'server.cjs'), SERVER);
await writeFile(join(repo, '.contextlanes.json'), JSON.stringify({ cache: ['node_modules'], setup: [{ name: 'Marker', command: ['/usr/bin/true'] }], services: [
  { name: 'api', command: [process.execPath, 'server.cjs'], health: { path: '/status' } }, { name: 'web', command: [process.execPath, 'server.cjs'] }] }, null, 2));
await git('add', '.'); await git('commit', '-m', 'Fixture');
await writeFile(join(repo, '.env.local'), 'SECRET=1\n');
await mkdir(join(repo, 'node_modules/dep'), { recursive: true }); await writeFile(join(repo, 'node_modules/dep/index.js'), '//\n');

const config = Config.parse({ listen: { port: 4699 }, paths: { data: join(root, 'data'), lanes }, access: { shellOwner: 'fixture' }, lanes: { launchHosts: false } });
await mkdir(config.paths.data, { recursive: true });
const store = Store.open(join(config.paths.data, 'db.sqlite'));
const bus = new EventBus();
const hosts = new HostLinks({ store, bus });
const manager = new LaneManager({ store, bus, config, run: runCommand });
const runtime = new Runtime({ store, bus, config, run: runCommand });
const setup = new SetupManager(config, store, runCommand, { changed: async () => {} });
const app = buildServer({ store, bus, lanes: manager, hosts, config, version: 'check', setup, runtime });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_BIN, args: ['--no-sandbox'] });
const started = [];
try {
  store.addProject({ id: 'billing', name: 'Billing', path: repo });
  for (const task of ['Billing phase 0', 'Solver tests']) started.push((await manager.start({ project: 'billing', task, agent: 'codex' })).id);

  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.addCookies([{ name: 'cl-owner', value: store.ownerSession(), url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/p/billing/run`);
    await page.getByRole('heading', { name: 'Environments' }).waitFor();

    if (width === 1440) {
      await page.getByRole('button', { name: 'Review recipe' }).first().click();
      await page.getByRole('button', { name: 'Approve this recipe' }).click();
      await page.getByRole('button', { name: 'Start environment' }).first().click();
      await page.locator('.svc').first().waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Logs' }).first().click();
      await page.locator('.logs .term').getByText('listening').waitFor();
    }
    await page.waitForFunction(() => document.querySelectorAll('.ticks i').length > 1, undefined, { timeout: 20_000 }).catch(() => {});
    await page.screenshot({ path: join(out, `run-${width}.png`), fullPage: true });
    await page.goto(`${base}/p/billing/work?lane=${encodeURIComponent(started[0])}`);
    await page.getByText('Environment', { exact: true }).waitFor();
    if (width === 1440) await page.locator('.pane.r').getByText('api').waitFor();
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sideways scroll at ${width}`);
    await context.close();
  }
  console.log('phase 2 browser check passed');
} finally {
  for (const id of started) await runtime.stop(id).catch(() => {});
  await browser.close();
  await app.close(); await hosts.close(); store.close();
  for (const lane of started) await runCommand('tmux', ['kill-session', '-t', `cl-billing-${lane.slice(-2)}`]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
