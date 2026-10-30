import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BenchResult, BenchRun, BenchTask, LaneEvent } from "@contextlanes/protocol";
import type { z } from "zod";
import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import type { LaneManager } from "./lanes/manager.js";
import type { Runner } from "./run.js";
import { oneshot } from "./runtime.js";
import { sandbox } from "./sandbox.js";

/**
 * `contextlanes bench`: the phase 3 gate. Each task runs in two fresh lanes from the same commit with the
 * same agent and model: a baseline lane without project notes, get_brief or delegate, and a lane with
 * them. A run ends when its agent finishes its first task (its turn ends with nothing queued); then the
 * task's check runs in that lane's checkout, in the sandbox. Tokens are the agent's own reported usage.
 * The owner still answers every permission the lanes ask for; the bench never approves anything.
 */
export class Bench {
  constructor(private deps: { config: Config; store: Store; bus: EventBus; lanes: LaneManager; run: Runner; poll?: number }) {}
  private file(id: string) { return join(this.deps.config.paths.data, "bench", `${id}.json`); }
  async get(id: string): Promise<BenchResult | null> { return readFile(this.file(id), "utf8").then((t) => JSON.parse(t) as BenchResult, () => null); }
  private saving: Promise<void> = Promise.resolve();
  /** Saves one at a time: progress from both lanes of a task arrives together. */
  private save(r: BenchResult): Promise<void> {
    const text = JSON.stringify(r, null, 2);
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(join(this.deps.config.paths.data, "bench"), { recursive: true, mode: 0o700 });
      await writeFile(`${this.file(r.id)}.tmp`, text, { mode: 0o600 }); await rename(`${this.file(r.id)}.tmp`, this.file(r.id));
    });
    return this.saving;
  }

  /** Starts the bench in the background and returns its id. */
  async start(tasks: z.output<typeof BenchTask>[]): Promise<BenchResult> {
    const result: BenchResult = { id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null, tasks: tasks.map((t) => ({ task: t.task, project: t.project, runs: [] })) };
    await this.save(result);
    void (async () => {
      for (const [i, t] of tasks.entries()) {
        // Both lanes of a task run at the same time, so both meet the same state of the machine.
        const runs = await Promise.all([true, false].map((baseline) => this.runOne(t, baseline, (run) => { result.tasks[i]!.runs = [...result.tasks[i]!.runs.filter((r) => r.baseline !== baseline), run]; void this.save(result); })));
        result.tasks[i]!.runs = runs;
        await this.save(result);
      }
      result.finishedAt = new Date().toISOString();
      await this.save(result);
    })().catch(async (err) => { result.finishedAt = new Date().toISOString(); result.tasks.forEach((t) => t.runs.forEach((r) => { if (r.state !== "done") { r.state = "failed"; r.detail = String(err); } })); await this.save(result); });
    return result;
  }

  private async runOne(t: z.output<typeof BenchTask>, baseline: boolean, progress: (run: BenchRun) => void): Promise<BenchRun> {
    const { store, lanes, run, config } = this.deps;
    const lane = await lanes.start({ project: t.project, task: t.task, agent: t.agent, model: t.model, base: t.base, mode: "edits", goal: `Bench ${baseline ? "baseline" : "with phase 3"}`, baseline });
    const started = Date.parse(lane.createdAt);
    const row: BenchRun = { lane: lane.id, baseline, tokens: null, minutes: null, passed: null, state: "running", detail: null };
    progress(row);
    const deadline = Date.now() + t.timeoutMinutes * 60_000;
    // Done when a turn has ended and no prompt is waiting: the first task is finished.
    for (;;) {
      const events = this.all(lane.id);
      const ended = events.some((e) => e.type === "agent.turn" && !e.payload.active);
      const busy = events.at(-1)?.type === "agent.turn" && (events.findLast((e) => e.type === "agent.turn") as Extract<LaneEvent, { type: "agent.turn" }>).payload.active;
      const failed = store.getLane(lane.id)?.state === "failed";
      if ((ended && !busy) || failed || Date.now() > deadline) {
        row.minutes = Math.round((Date.now() - started) / 6000) / 10;
        row.tokens = events.filter((e): e is Extract<LaneEvent, { type: "usage.turn" }> => e.type === "usage.turn").reduce((n, e) => n + (e.payload.inputTokens ?? 0) + (e.payload.outputTokens ?? 0) + (e.payload.cacheReadTokens ?? 0) + (e.payload.cacheWriteTokens ?? 0), 0) || null;
        if (failed || Date.now() > deadline) { row.state = "failed"; row.detail = failed ? "The lane failed." : `No result within ${t.timeoutMinutes} minutes.`; progress(row); return row; }
        break;
      }
      await new Promise((r) => setTimeout(r, this.deps.poll ?? 5000));
    }
    row.state = "checking"; progress(row);
    const result = await oneshot(run, lane.worktree, t.check, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOST: "127.0.0.1", CONTEXTLANES_LANE: lane.id }, 600, sandbox(config));
    row.passed = result.ok; row.state = "done"; row.detail = result.ok ? null : result.output.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    progress(row);
    return row;
  }

  private all(lane: string): LaneEvent[] {
    const out: LaneEvent[] = [];
    for (;;) { const page = this.deps.store.events(lane, out.at(-1)?.seq ?? 0); if (!page.length) return out; out.push(...page); }
  }
}

