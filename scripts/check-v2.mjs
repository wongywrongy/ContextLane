// Deterministic browser gates: a temporary daemon, fake Runner and seeded lane events; no agents or user repositories.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '../apps/daemon/node_modules/playwright-core/index.mjs';
import { Config, Store, EventBus, HostLinks, LaneManager, buildServer } from '../apps/daemon/dist/index.js';
import { SetupManager } from '../apps/daemon/dist/setup.js';
import { Schedules } from '../apps/daemon/dist/schedules.js';

const root = await mkdtemp('/tmp/cl-v2-browser-');
const screenshots = process.argv[2] ?? join(root, 'screenshots');
await mkdir(screenshots, { recursive: true });
const store = Store.open(':memory:'), bus = new EventBus();
const config = Config.parse({ paths: { data: root, lanes: root }, access: { owner: 'fixture@example.invalid' }, lanes: { launchHosts: false } });
const run = async (cmd, args) => ({ stdout: cmd === 'tmux' && args[0] === 'display-message' ? '0' : cmd === 'git' ? args[0] === 'rev-list' ? '1' : ['rev-parse', 'merge-base'].includes(args[0]) ? 'a'.repeat(40) : args.includes('--numstat') ? '3\t1\tapp.ts\n' : '' : '' });
run.terminal = () => { let output; return { write: text => output?.(text), resize() {}, kill() {}, onData(fn) { output = fn; queueMicrotask(() => fn('\x1b[32mContextLanes browser fixture\x1b[0m\r\nNative session input stays in this pane.\r\n')); return { dispose() {} }; }, onExit() { return { dispose() {} }; } }; };
const setup = new SetupManager(config, store, run); await setup.initialize();
setup.detectAgents = async () => ["codex", "claude-code"].map(id => ({ id, name: id === "codex" ? "Codex" : "Claude Code", installed: true, status: "Ready", source: "built-in", support: "full" }));
const hosts = new HostLinks({ store, bus });
const lanes = new LaneManager({ store, bus, config, run });
const schedules = new Schedules({ config, store, lanes, setup, run, home: root, node: process.execPath, cli: join(root, 'fixture-cli') });
const app = buildServer({ store, bus, config, hosts, lanes, setup, schedules, run, version: 'v2-browser-fixture' });
const project = store.addProject({ id: 'boardfixture', name: 'Fixture project', path: join(root, 'repo') });
await mkdir(project.path);
for (const [index, state] of ['working', 'needs_you', 'in_review', 'merged', 'failed', 'failed', 'working'].entries()) {
  const n = index + 1, id = `boardfixture/0${n}`;
  const lane = store.insertLane({ id, n, project: project.id, goal: null, task: ['Invoice API', 'Currency choice', 'Invoice page', 'Receipt merged', 'Retry failed check', 'Retry failed server', 'Payment tests'][index], agent: index % 2 ? 'claude-code' : 'codex', kind: 'cli', model: null, mode: 'ask', branch: `lane/0${n}-fixture`, worktree: project.path, terminal: `fixture-${n}`, hostUnit: null, base: 'main', state: 'working', colour: `lc${index % 6 + 1}` });
  store.appendEvent(id, { type: 'lane.created', payload: { task: lane.task, agent: lane.agent, branch: lane.branch, worktree: lane.worktree } });
  store.appendEvent(id, { type: 'agent.turn', payload: { active: state === 'working' } });
  if (n === 1) {
    store.appendEvent(id, { type: 'usage', payload: { contextUsed: 45000, contextSize: 100000 } });
    store.appendEvent(id, { type: 'usage.limit', payload: { window: '7d', usedPct: 25, resetsAt: new Date(Date.now() + 86400000).toISOString(), source: 'codex-log' } });
  }
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
const errors = [], requests = [];
try {
  const context = await browser.newContext();
  await context.addInitScript(({ token, origin }) => { if (location.origin === origin) localStorage.setItem('cl-session', token); }, { token: store.ownerSession(), origin: url });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); page.on('request', request => requests.push(request.url()));
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `horizontal scroll at ${page.url()}`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const routes = [["projects", "/"], ["board", `/p/${project.id}/work`], ["lane", `/p/${project.id}/work?lane=boardfixture%2F01`], ["review", `/p/${project.id}/review`], ["run", `/p/${project.id}/run`], ["architecture", `/p/${project.id}/architecture`], ["insights", `/p/${project.id}/insights`], ["inbox", "/inbox"], ["models", "/models"], ["settings", "/settings"], ["setup", "/setup"]];
    for (const [name, route] of routes) {
      await page.goto(`${url}${route}`); await page.waitForTimeout(600); await page.evaluate(() => document.fonts.ready);
      if (name === "board") { assert.equal(await page.locator('.board-column').count(), 5); await page.getByText('ctx 45%', { exact: true }).waitFor(); }
      if (name === "lane") await page.locator(".tmux-status").getByText("7d 25%", { exact: true }).waitFor();
      if (name === "models") await page.getByText("7d 25%", { exact: true }).waitFor();
      if (name === "projects") await page.locator('.project-need').waitFor();
      await noOverflow(); await page.screenshot({ path: join(screenshots, `${name}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${url}/p/${project.id}/work`); await page.locator('.board-card').first().waitFor();
  await page.keyboard.press('j'); assert.equal(await page.locator(':focus').evaluate(el => el.closest('[data-lane]').dataset.lane), 'boardfixture/01');
  await page.keyboard.press('j'); assert.equal(await page.locator(':focus').evaluate(el => el.closest('[data-lane]').dataset.lane), 'boardfixture/07');
  await page.keyboard.press('k'); await page.keyboard.press('r'); assert.ok(page.url().includes('/review'));
  await page.keyboard.press('?'); await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor(); await page.keyboard.press('Escape');
  await page.keyboard.press(':'); const input = page.getByRole('textbox', { name: 'Jump to a project or lane' }); await input.waitFor(); const before = page.url(); await input.fill('rjk'); assert.equal(page.url(), before); await page.keyboard.press('Escape');
  await page.goto(`${url}/inbox`); await page.getByRole('button', { name: 'USD', exact: true }).waitFor(); await page.keyboard.press('a'); assert.equal(await page.locator(':focus').textContent(), 'USD');
  await page.locator('header.status-top[aria-busy=false]').waitFor();
  await page.keyboard.press('Control+1'); await page.locator('.tty').waitFor(); assert.equal(await page.locator('.lane-pane').count(), 1);
  await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.press('Control+d'); assert.equal(await page.locator('.lane-pane').count(), 1);
  await page.getByRole('button', { name: /Split right/ }).focus(); await page.keyboard.press('Control+d'); await page.locator('.lane-pane').nth(1).waitFor(); assert.equal(await page.locator('.lane-pane').count(), 2);
  await page.keyboard.press('Control+Shift+d'); await page.locator('.lane-pane').nth(2).waitFor(); assert.equal(await page.locator('.lane-pane').count(), 3);
  await page.reload(); await page.locator('.lane-pane').first().waitFor(); assert.equal(await page.locator('.lane-pane').count(), 3); await noOverflow();
  await page.screenshot({ path: join(screenshots, 'panes-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 1000 }); await noOverflow(); await page.screenshot({ path: join(screenshots, 'panes-390.png'), fullPage: true });
  await page.goto(`${url}/settings`); await page.getByLabel('Theme', { exact: true }).selectOption('light'); assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.goto(`${url}/p/${project.id}/work`); await page.locator('.board-card').first().waitFor(); await noOverflow(); await page.screenshot({ path: join(screenshots, 'board-light-390.png'), fullPage: true });
  await page.goto(`${url}/settings`); await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  assert.ok(!requests.some(r => /fonts.googleapis|fonts.gstatic|\/covers\//.test(r)), 'fonts are local and covers are unused');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${url}/p/${project.id}/work`); await page.locator('.board-card').first().waitFor();
  const [checkpoint] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/boardfixture/01/checkpoint') && r.request().method() === 'POST'), page.locator('.board-card[data-lane="boardfixture/01"]').dragTo(page.locator('[data-column="In review"]'))]);
  assert.equal(checkpoint.status(), 202);
  const [archive] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/boardfixture/05/archive') && r.request().method() === 'POST'), page.locator('.board-card[data-lane="boardfixture/05"]').dragTo(page.locator('.board-archive'))]);
  assert.equal(archive.status(), 200); assert.equal(store.getLane('boardfixture/05').state, 'archived');
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.locator('[aria-label="Actions for boardfixture/06"]').click();
  const [phoneArchive] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/boardfixture/06/archive') && r.request().method() === 'POST'), page.locator('.board-card[data-lane="boardfixture/06"]').getByRole('button', { name: 'Archive', exact: true }).click()]);
  assert.equal(phoneArchive.status(), 200);
  await page.locator('[aria-label="Actions for boardfixture/07"]').click();
  const [phoneCheckpoint] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/boardfixture/07/checkpoint') && r.request().method() === 'POST'), page.locator('.board-card[data-lane="boardfixture/07"]').getByRole('button', { name: 'Ask for review', exact: true }).click()]);
  assert.equal(phoneCheckpoint.status(), 202);
  await noOverflow(); assert.deepEqual(errors, []);
  console.log(`Every page passed at 1440/390 px; keyboard/pane persistence, themes and drag/menu APIs passed; screenshots: ${screenshots}`);
} finally { await browser.close(); await app.close(); store.close(); await rm(root, { recursive: true, force: true }); }
