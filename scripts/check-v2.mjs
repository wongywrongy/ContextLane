// Deterministic browser gates: a temporary daemon, fake Runner and seeded lane events; no agents or user repositories.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '../apps/daemon/node_modules/playwright-core/index.mjs';
import { Config, Store, EventBus, HostLinks, LaneManager, buildServer } from '../apps/daemon/dist/index.js';
import { SetupManager } from '../apps/daemon/dist/setup.js';

const root = await mkdtemp('/tmp/cl-v2-browser-');
const screenshots = process.argv[2] ?? join(root, 'screenshots');
await mkdir(screenshots, { recursive: true });
const store = Store.open(':memory:'), bus = new EventBus();
const config = Config.parse({ paths: { data: root, lanes: root }, access: { owner: 'fixture@example.invalid' }, lanes: { launchHosts: false } });
const run = async (cmd, args) => ({ stdout: cmd === 'git' ? args[0] === 'rev-list' ? '1' : ['rev-parse', 'merge-base'].includes(args[0]) ? 'a'.repeat(40) : args.includes('--numstat') ? '3\t1\tapp.ts\n' : '' : '' });
const setup = new SetupManager(config, store, run); await setup.initialize();
const hosts = new HostLinks({ store, bus });
const app = buildServer({ store, bus, config, hosts, lanes: new LaneManager({ store, bus, config, run }), setup, run, version: 'v2-browser-fixture' });
const project = store.addProject({ id: 'boardfixture', name: 'Fixture project', path: join(root, 'repo') });
await mkdir(project.path);
for (const [index, state] of ['working', 'needs_you', 'in_review', 'merged', 'failed', 'failed', 'working'].entries()) {
  const n = index + 1, id = `boardfixture/0${n}`;
  const lane = store.insertLane({ id, n, project: project.id, goal: null, task: ['Invoice API', 'Currency choice', 'Invoice page', 'Receipt merged', 'Retry failed check', 'Retry failed server', 'Payment tests'][index], agent: index % 2 ? 'claude-code' : 'codex', kind: 'acp', model: null, mode: 'ask', branch: `lane/0${n}-fixture`, worktree: project.path, terminal: `fixture-${n}`, hostUnit: null, base: 'main', state: 'working', colour: `lc${index % 6 + 1}` });
  store.appendEvent(id, { type: 'lane.created', payload: { task: lane.task, agent: lane.agent, branch: lane.branch, worktree: lane.worktree } });
  store.appendEvent(id, { type: 'agent.turn', payload: { active: state === 'working' } });
  if (n === 1) store.appendEvent(id, { type: 'usage', payload: { contextUsed: 45000, contextSize: 100000 } });
  if (state === 'needs_you') store.appendEvent(id, { type: 'permission.requested', payload: { requestId: 'currency', title: 'Which currency should invoices use?', kind: 'question', options: [{ id: 'usd', label: 'USD', kind: 'allow_once' }, { id: 'eur', label: 'EUR', kind: 'allow_once' }] } });
  if (['in_review', 'merged'].includes(state)) {
    const cp = randomUUID();
    store.insertCheckpoint({ id: cp, lane: id, base: 'a'.repeat(40), head: 'b'.repeat(40), summary: lane.task, checks: [], screenshots: [], files: [{ path: 'app.ts', added: 3, removed: 1 }], plan: [], unplanned: [], process: [], signal: 'strong', decision: state === 'merged' ? 'approved' : null, prUrl: null, createdAt: new Date().toISOString() });
    store.setJudge(cp, { state: 'done', model: 'fixture', verdict: 'fix first', headline: 'Check the empty input', findings: [{ file: 'app.ts', line: 2, text: 'Handle empty input before calling the API.', severity: 'should fix' }], skipped: [], error: null, at: new Date().toISOString() });
    store.appendEvent(id, { type: 'checkpoint.created', payload: { checkpointId: cp, summary: lane.task, head: 'b'.repeat(40) } });
    store.appendEvent(id, { type: 'checkpoint.judged', payload: { checkpointId: cp, state: 'done', verdict: 'fix first' } });
    store.setLaneState(id, 'in_review');
    if (state === 'merged') store.setLaneState(id, 'merged');
  } else if (state !== 'working') store.setLaneState(id, state, state === 'failed' ? 'The fixture check exited with code 1.' : undefined);
}
const url = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {}) });
const errors = [];
try {
  const context = await browser.newContext();
  await context.addInitScript(({ token, origin }) => { if (location.origin === origin) localStorage.setItem('cl-session', token); }, { token: store.ownerSession(), origin: url });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal scroll at ${page.url()}`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${url}/p/${project.id}/work`);
    await page.locator('.board-card').first().waitFor();
    assert.equal(await page.locator('.board-column').count(), 5);
    await page.getByText('ctx 45%', { exact: true }).waitFor();
    await noOverflow(); await page.screenshot({ path: join(screenshots, `board-${width}.png`), fullPage: true });
    await page.goto(url); await page.locator('.project-need').waitFor();
    await noOverflow(); await page.screenshot({ path: join(screenshots, `projects-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${url}/p/${project.id}/work`); await page.locator('.board-card').first().waitFor();
  const checkpoint = page.waitForResponse(r => r.url().endsWith('/boardfixture/01/checkpoint') && r.request().method() === 'POST');
  await page.locator('[data-lane="boardfixture/01"]').dragTo(page.locator('[data-column="In review"]'));
  assert.equal((await checkpoint).status(), 202);
  const archive = page.waitForResponse(r => r.url().endsWith('/boardfixture/05/archive') && r.request().method() === 'POST');
  await page.locator('[data-lane="boardfixture/05"]').dragTo(page.locator('.board-archive'));
  assert.equal((await archive).status(), 200); assert.equal(store.getLane('boardfixture/05').state, 'archived');
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.locator('[aria-label="Actions for boardfixture/06"]').click();
  const phoneArchive = page.waitForResponse(r => r.url().endsWith('/boardfixture/06/archive') && r.request().method() === 'POST');
  await page.locator('[data-lane="boardfixture/06"]').getByRole('button', { name: 'Archive', exact: true }).click();
  assert.equal((await phoneArchive).status(), 200);
  await page.locator('[aria-label="Actions for boardfixture/07"]').click();
  const phoneCheckpoint = page.waitForResponse(r => r.url().endsWith('/boardfixture/07/checkpoint') && r.request().method() === 'POST');
  await page.locator('[data-lane="boardfixture/07"]').getByRole('button', { name: 'Ask for review', exact: true }).click();
  assert.equal((await phoneCheckpoint).status(), 202);
  await noOverflow(); assert.deepEqual(errors, []);
  console.log(`Board/Home passed at 1440 and 390 px; drag/menu APIs passed; screenshots: ${screenshots}`);
} finally { await browser.close(); await app.close(); store.close(); await rm(root, { recursive: true, force: true }); }
