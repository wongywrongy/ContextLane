import { changedAreas } from "./visualdiff.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { testSummary, type ChangedFile, type Checkpoint, type CheckResult, type Lane, type LaneEvent, type Recipe, type Screenshot, type TestCounts } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { NotFound, Refused } from "./lanes/manager.js";
import type { Runner } from "./run.js";
import { sandbox } from "./sandbox.js";
import { oneshot, type Runtime } from "./runtime.js";

/** Takes one page's picture. Injected so tests never need a browser. */
export type Shooter = (url: string, file: string) => Promise<void>;
type Deps = { store: Store; bus: EventBus; config: Config; run: Runner; runtime: Runtime; shoot?: Shooter };

export function parseNumstat(text: string): ChangedFile[] {
  return text.split("\n").filter(Boolean).map((line) => {
    const [added, removed, ...path] = line.split("\t");
    return { path: path.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
  });
}

/**
 * Changed files whose path shares no word with the plan.
 * shortcut: word overlap, not meaning, so a plan in other words flags too much; upgrade when the local model can compare them (phase 3).
 */
export function unplannedFiles(files: string[], plan: string[]): string[] {
  const words = new Set(plan.join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3));
  return files.filter((file) => !file.toLowerCase().replace(/\.[a-z0-9]+$/, "").split(/[^a-z0-9]+/).some((w) => words.has(w)));
}

const TESTS = /\b(test|tests|vitest|jest|pytest|mocha|playwright|check|cargo test|go test)\b/i;

/** What the log shows about how the work was done. Each line is measured; none is a model's opinion. */
export function processSignal(events: LaneEvent[], checks: CheckResult[], hasPlan: boolean, unplanned: string[]): { process: Checkpoint["process"]; signal: Checkpoint["signal"] } {
  const calls = new Map<string, { kind?: string; title: string; status?: string; seq: number; tested: boolean }>();
  for (const event of events) {
    if (event.type === "tool.call") calls.set(event.payload.callId, { kind: event.payload.kind, title: event.payload.title, status: event.payload.status, seq: event.seq, tested: !!event.payload.tests?.length });
    if (event.type === "tool.update") {
      const old = calls.get(event.payload.callId);
      if (old) calls.set(event.payload.callId, { ...old, ...(event.payload.status ? { status: event.payload.status } : {}), ...(event.payload.title ? { title: event.payload.title } : {}), seq: event.seq, tested: old.tested || !!event.payload.tests?.length });
    }
  }
  const all = [...calls.values()];
  const changed = all.filter((c) => ["edit", "delete", "move"].includes(c.kind ?? "")).map((c) => c.seq);
  const lastEdit = changed.length ? Math.max(...changed) : 0;
  const ranTests = all.some((c) => c.seq > lastEdit && c.status === "completed" && (c.kind === "test" || c.tested || (c.kind === "execute" && TESTS.test(c.title))));
  const failed = all.filter((c) => c.status === "failed");
  const process = [
    { label: "Ran the tests after the last change", ok: ranTests },
    ...(checks.length ? [{ label: "Recipe checks pass", ok: checks.every((c) => c.passed) }] : []),
    { label: hasPlan ? "Stayed inside the plan" : "Wrote a plan first", ok: hasPlan && !unplanned.length },
    ...(failed.length ? [{ label: `Finished after ${failed.length} failed ${failed.length === 1 ? "step" : "steps"}`, ok: all.at(-1)?.status !== "failed" }] : []),
  ];
  const misses = process.filter((p) => !p.ok).length;
  return { process, signal: misses === 0 ? "strong" : misses === 1 ? "mixed" : "weak" };
}

/** On checkpoint: run the recipe's checks, take screenshots, compare plan and diff, store a checkpoint row. */
export class Checker {
  private readonly running = new Set<string>();

  constructor(private readonly deps: Deps) {}

  /** Refuses at once when review could not make sense, so the agent can fix it; the rest runs in the background. */
  async begin(id: string, summary: string): Promise<{ started: true }> {
    const { store, run } = this.deps;
    const lane = store.getLane(id);
    if (!lane) throw new NotFound(`no lane ${id}`);
    if (lane.state !== "working") throw new Refused(`A checkpoint needs a working lane; this one is ${lane.state.replace("_", " ")}.`);
    if (this.running.has(id)) throw new Refused("A checkpoint is already running for this lane.");
    // Claimed before the first await, so the agent's checkpoint tool and the owner's button never both build.
    this.running.add(id);
    try { return await this.prepare(lane, summary); } catch (err) { this.running.delete(id); throw err; }
  }

  private async prepare(lane: Lane, summary: string): Promise<{ started: true }> {
    const { run } = this.deps;
    const id = lane.id;
    const dirty = (await run("git", ["status", "--porcelain"], { cwd: lane.worktree })).stdout.trim();
    if (dirty) throw new Refused("Commit your changes first; review covers commits, and these are not committed yet.");
    // A lane started from a branch that exists only on origin compares with origin's copy.
    const name = lane.base ?? "main";
    const base = (await run("git", ["merge-base", name, "HEAD"], { cwd: lane.worktree }).catch(() => run("git", ["merge-base", `origin/${name}`, "HEAD"], { cwd: lane.worktree }))
      .catch(() => { throw new Refused(`This lane cannot be compared with ${name}; that branch was not found.`); })).stdout.trim();
    if (!(await run("git", ["rev-list", "--count", `${base}..HEAD`], { cwd: lane.worktree })).stdout.trim().match(/^[1-9]/)) throw new Refused("This lane has no commits to review yet.");
    const recipe = await this.deps.runtime.recipeFor(lane);
    void this.build(lane, summary, base, recipe).catch((err: unknown) => this.report(id, "Checkpoint", false, 0, err instanceof Error ? err.message : String(err))).finally(() => this.running.delete(id));
    return { started: true };
  }

  async diff(checkpoint: Checkpoint, file?: string): Promise<string> {
    const lane = this.deps.store.getLane(checkpoint.lane)!;
    const project = this.deps.store.getProject(lane.project)!;
    if (file !== undefined && !checkpoint.files.some((f) => f.path === file)) throw new NotFound("no such file in this checkpoint");
    return (await this.deps.run("git", ["diff", "--no-color", "--no-renames", checkpoint.base, checkpoint.head, ...(file === undefined ? [] : ["--", file])], { cwd: project.path })).stdout.slice(0, 500_000);
  }

  private report(lane: string, name: string, passed: boolean, ms: number, detail: string, counts: TestCounts | null = null): CheckResult {
    this.deps.bus.publish(this.deps.store.appendEvent(lane, { type: "check.result", payload: { name, passed, detail } }));
    return { name, passed, ms, detail, counts };
  }

  private async build(lane: Lane, summary: string, base: string, recipe: Recipe | null): Promise<void> {
    const { store, bus, run } = this.deps;
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: lane.worktree })).stdout.trim();
    const id = randomUUID();
    const checks: CheckResult[] = [];
    for (const check of recipe?.checks ?? []) {
      const result = await oneshot(run, lane.worktree, check.command, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOST: "127.0.0.1", CONTEXTLANES_LANE: lane.id }, check.timeoutSeconds, sandbox(this.deps.config));
      checks.push(this.report(lane.id, check.name, result.ok, result.ms, result.output.trim().slice(-1000), testSummary(result.output, check.command)));
    }
    const files = parseNumstat((await run("git", ["diff", "--numstat", "--no-renames", base, head], { cwd: lane.worktree })).stdout);
    const events = await this.history(lane.id);
    const plan = events.findLast((e) => e.type === "agent.plan");
    const entries = plan?.type === "agent.plan" ? plan.payload.entries : [];
    const unplanned = entries.length ? unplannedFiles(files.map((f) => f.path), entries.map((e) => e.text)) : [];
    const screenshots = recipe?.services.length ? await this.screenshots(lane, recipe, base, id) : [];
    const moved = (await run("git", ["rev-parse", "HEAD"], { cwd: lane.worktree })).stdout.trim() !== head;
    if (moved) throw new Error("The lane has new commits since this checkpoint started. Send it again.");
    if (store.getLane(lane.id)!.state !== "working") throw new Error("The lane is waiting on a question; answer it and send the checkpoint again.");
    const checkpoint: Checkpoint = { id, lane: lane.id, base, head, summary, checks, screenshots, files, plan: entries, unplanned, ...processSignal(events, checks, !!entries.length, unplanned), decision: null, prUrl: null, createdAt: new Date().toISOString() };
    const written = store.tx(() => {
      store.insertCheckpoint(checkpoint);
      return [store.appendEvent(lane.id, { type: "checkpoint.created", payload: { checkpointId: id, summary, head } }), store.setLaneState(lane.id, "in_review", "checkpoint")];
    });
    for (const event of written) bus.publish(event);
  }

  private async history(lane: string): Promise<LaneEvent[]> {
    const all: LaneEvent[] = [];
    for (;;) {
      const page = this.deps.store.events(lane, all.at(-1)?.seq ?? 0);
      if (!page.length) return all;
      all.push(...page);
    }
  }

  /** After from the lane's running app, before from the base commit run on its own. A failure leaves a note, not a block. */
  private async screenshots(lane: Lane, recipe: Recipe, base: string, id: string): Promise<Screenshot[]> {
    const { config, runtime } = this.deps;
    const dir = join(config.paths.data, "checkpoints", id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const shots: Screenshot[] = recipe.screenshots.map((path) => ({ path, url: null, before: null, after: null, note: null }));
    const note = (index: number, text: string) => { shots[index]!.note = shots[index]!.note ? `${shots[index]!.note} ${text}` : text; };
    const shoot = this.deps.shoot ?? this.playwright();
    const take = async (origin: string, side: "before" | "after") => {
      for (const [index, shot] of shots.entries()) {
        const file = `${index}-${side}.png`;
        try { await shoot(`${origin}${shot.path}`, join(dir, file)); shot[side] = file; }
        catch (err) { note(index, `No ${side} picture: ${err instanceof Error ? err.message.split("\n")[0] : "the browser failed"}.`); }
      }
    };
    try {
      const env = await runtime.start(lane.id);
      const service = env.services.find((s) => s.name === "web") ?? env.services[0]!;
      if (service.state !== "healthy") throw new Error(`${service.name} is ${service.state}`);
      for (const shot of shots) shot.url = service.url ? `${service.url}${shot.path}` : null;
      await take(`http://127.0.0.1:${service.port}`, "after");
    } catch (err) { shots.forEach((_, i) => note(i, `No after picture: ${err instanceof Error ? err.message : "the app did not start"}.`)); }
    try { await runtime.fromCommit(lane, recipe, base, (port) => take(`http://127.0.0.1:${port}`, "before")); }
    catch (err) { shots.forEach((_, i) => note(i, `No before picture: ${err instanceof Error ? err.message : "the base commit did not start"}.`)); }
    for (const shot of shots) if (shot.before && shot.after) shot.changes = await changedAreas(join(dir, shot.before), join(dir, shot.after)).catch(() => null);
    return shots;
  }

  private playwright(): Shooter {
    return async (url, file) => {
      const { chromium } = await import("playwright-core");
      const browser = await chromium.launch({ headless: true, ...(this.deps.config.checker.chromium ? { executablePath: this.deps.config.checker.chromium } : {}) });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(url, { waitUntil: "load", timeout: 20_000 });
        await page.waitForTimeout(500);
        await page.screenshot({ path: file });
      } finally { await browser.close(); }
    };
  }
}
