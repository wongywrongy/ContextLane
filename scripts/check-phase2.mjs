// After pnpm build: real systemd units, a throwaway fixture repo and Chromium at both widths.
// PLAYWRIGHT_MODULE and CHROMIUM_BIN point at installed browser tools; OUT keeps the screenshots.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Checker, Config, EventBus, HostLinks, LaneManager, Runtime, Store, buildServer, runCommand } from '../apps/daemon/dist/index.js';
import { SetupManager } from '../apps/daemon/dist/setup.js';

const exec = promisify(execFile);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright-core');
const out = process.env.OUT ?? tmpdir();
const root = await mkdtemp(join(tmpdir(), 'cl-phase2-'));
const repo = join(root, 'billing'), lanes = join(root, 'lanes'), remote = join(root, 'remote.git');
const gitIn = (cwd, ...args) => exec('git', ['-c', 'user.name=CL', '-c', 'user.email=cl@example.invalid', ...args], { cwd });
const git = (...args) => gitIn(repo, ...args);
// Real git against a throwaway bare remote; gh is the only fake, so nothing leaves this folder.
const run = async (cmd, args, options) => cmd === 'gh' ? { stdout: args[1] === 'create' ? 'https://github.invalid/pr/1\n' : '' } : runCommand(cmd, args, options);
run.terminal = runCommand.terminal;
const SERVER = `const http = require("node:http"); console.log("listening"); http.createServer((req, res) => { console.log(req.method, req.url, 200); res.setHeader("content-type", "text/html"); res.end("<h1>Billing</h1>"); }).listen(Number(process.env.PORT), process.env.HOST);`;

await mkdir(repo, { recursive: true });
await mkdir(remote);
await gitIn(remote, 'init', '--bare', '-b', 'main');
await git('init', '-b', 'main');
await git('remote', 'add', 'origin', remote);
await writeFile(join(repo, '.gitignore'), '.env*\nnode_modules\n');
await writeFile(join(repo, 'server.cjs'), SERVER);
await writeFile(join(repo, '.contextlanes.json'), JSON.stringify({ cache: ['node_modules'], setup: [{ name: 'Marker', command: ['/usr/bin/true'] }], services: [
  { name: 'api', command: [process.execPath, 'server.cjs'], health: { path: '/status' } }, { name: 'web', command: [process.execPath, 'server.cjs'] }],
  checks: [{ name: 'Tests pass', command: ['/usr/bin/true'] }, { name: 'Types clean', command: ['/usr/bin/true'] }], screenshots: ['/clubs/42/fees'] }, null, 2));
await git('add', '.'); await git('commit', '-m', 'Fixture'); await git('push', 'origin', 'main');
await writeFile(join(repo, '.env.local'), 'SECRET=1\n');
await mkdir(join(repo, 'node_modules/dep'), { recursive: true }); await writeFile(join(repo, 'node_modules/dep/index.js'), '//\n');

const config = Config.parse({ listen: { port: 4699 }, paths: { data: join(root, 'data'), lanes }, access: { shellOwner: 'fixture' }, lanes: { launchHosts: false } });
await mkdir(config.paths.data, { recursive: true });
const store = Store.open(join(config.paths.data, 'db.sqlite'));
const bus = new EventBus();
const hosts = new HostLinks({ store, bus });
const manager = new LaneManager({ store, bus, config, run });
// Real systemd, fake links: a fixture must never add routes to the machine's tailnet.
const previews = { publish: async (lane, service) => `https://${service}-fixture.invalid:4700`, unpublish: async () => {} };
const runtime = new Runtime({ store, bus, config, run, previews });
const checker = new Checker({ store, bus, config, run, runtime });
const setup = new SetupManager(config, store, run, { changed: async () => {} });
const app = buildServer({ store, bus, lanes: manager, hosts, config, version: 'check', setup, runtime, checker, run });
await app.listen({ host: '127.0.0.1', port: 0 });
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_BIN, args: ['--no-sandbox'] });
const session = store.ownerSession();
const started = [];
const until = async (check) => { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out: ${check}`); };
/** Commit real work in a lane and give it the history an agent would leave. */
const work = async (lane, name) => {
  await writeFile(join(lane.worktree, 'server.cjs'), SERVER.replace('<h1>Billing</h1>', `<h1>Billing</h1><p>${name}</p>`));
  await writeFile(join(lane.worktree, 'invoice.txt'), `${name}\n`);
  await writeFile(join(lane.worktree, 'notes.md'), 'nothing in the plan says so\n');
  await gitIn(lane.worktree, 'add', '.'); await gitIn(lane.worktree, 'commit', '-m', name);
  store.appendEvent(lane.id, { type: 'agent.plan', payload: { entries: [{ text: 'Invoice table with a draft status', status: 'completed' }, { text: 'Serve the new page from server', status: 'completed' }, { text: 'Webhook stub', status: 'pending' }] } });
  store.appendEvent(lane.id, { type: 'tool.call', payload: { callId: `${name}-1`, kind: 'read', title: 'Read server.cjs', files: ['server.cjs'], status: 'completed' } });
  store.appendEvent(lane.id, { type: 'tool.call', payload: { callId: `${name}-2`, kind: 'edit', title: 'Edit server.cjs', files: ['server.cjs'], status: 'failed' } });
  store.appendEvent(lane.id, { type: 'tool.update', payload: { callId: `${name}-2`, status: 'completed' } });
  store.appendEvent(lane.id, { type: 'tool.call', payload: { callId: `${name}-3`, kind: 'execute', title: 'pnpm test', files: [], status: 'completed' } });
  store.appendEvent(lane.id, { type: 'agent.message', payload: { text: 'Invoice page added. Each invoice starts as a draft; no payment code.', role: 'agent' } });
};
try {
  store.addProject({ id: 'billing', name: 'Billing', path: repo });
  for (const task of ['Billing phase 0', 'Solver tests']) started.push((await manager.start({ project: 'billing', task, agent: 'codex' })).id);

  const first = store.getLane(started[0]);
  await work(first, 'Invoices');
  store.setLaneState(started[1], 'needs_you');

  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addInitScript((token) => localStorage.setItem('cl-session', token), session);
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
    if (width === 1440) {
      await page.getByRole('button', { name: 'Send checkpoint to review' }).click();
      await page.getByText('Checks started').waitFor();
      await until(() => store.getLane(first.id).state === 'in_review');
    }
    await page.goto(`${base}/`);
    await page.locator('.need').first().waitFor();
    await page.locator('.need').getByRole('link', { name: 'Open' }).first().click();
    await page.waitForURL(/\/p\/billing\/review\?lane=/);
    await page.getByRole('heading', { name: 'Billing phase 0 · checkpoint 1' }).waitFor();
    await page.locator('.shot img').nth(1).waitFor();
    await page.locator('.frow').first().click();
    await page.locator('.dfv').waitFor();
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
    await page.screenshot({ path: join(out, `review-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `sideways scroll at ${width}`);
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript((token) => localStorage.setItem('cl-session', token), session);
  await context.addCookies([{ name: 'cl-owner', value: store.ownerSession(), url: base }]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/inbox`);
  await page.getByRole('link', { name: 'Open the review' }).click();
  await page.getByRole('button', { name: 'Request changes' }).click();
  await page.getByLabel('What should change').fill('Name the invoice table in the page title.');
  await page.getByRole('button', { name: 'Send to the agent' }).click();
  await until(() => store.getLane(first.id).state === 'working');
  assert.equal(store.pendingCommands(first.id).at(-1).payload.command.text, 'Name the invoice table in the page title.');

  await work(first, 'Named');
  await page.goto(`${base}/p/billing/work?lane=${encodeURIComponent(first.id)}`);
  await page.getByRole('button', { name: 'Send checkpoint to review' }).click();
  await until(() => store.getLane(first.id).state === 'in_review');
  await page.goto(`${base}/p/billing/review`);
  await page.getByRole('heading', { name: 'Billing phase 0 · checkpoint 2' }).waitFor();
  await page.getByRole('button', { name: 'Approve and merge' }).click();
  await until(() => store.getLane(first.id).state === 'merged');
  assert.equal(store.latestCheckpoint(first.id).prUrl, 'https://github.invalid/pr/1');
  assert.equal((await gitIn(remote, 'log', '--oneline', 'main')).stdout.trim().split('\n').length, 1, 'main must not move');
  assert.ok((await gitIn(remote, 'log', '--oneline', first.branch)).stdout.includes('Named'));

  await page.goto(`${base}/p/billing/run`);
  await page.getByRole('button', { name: 'Clean up 1 lane' }).click();
  await until(() => store.getLane(first.id).state === 'cleaned');
  await assert.rejects(access(first.worktree));
  await assert.rejects(exec('tmux', ['has-session', '-t', `=${first.terminal}`]));
  assert.ok((await git('branch', '--list', first.branch)).stdout.includes(first.branch), 'branch must stay');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('phase 2 browser check passed');
} finally {
  for (const id of started) await runtime.stop(id).catch(() => {});
  await browser.close();
  await app.close(); await hosts.close(); store.close();
  for (const lane of started) await runCommand('tmux', ['kill-session', '-t', `cl-billing-${lane.slice(-2)}`]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
