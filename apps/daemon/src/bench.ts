import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BenchResult, BenchRun, BenchTask, LaneEvent } from "@contextlanes/protocol";
import type { z } from "zod";
import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { NotFound, Refused, type LaneManager } from "./lanes/manager.js";
import type { Runner } from "./run.js";
import { oneshot } from "./runtime.js";
import { sandbox } from "./sandbox.js";

/**
 * `contextlanes bench`: the CLI benchmark gate. Each task runs in two fresh lanes from the same commit with the
 * same agent and model: a baseline lane without ContextLanes notes, briefs or MCP tools, and a lane with
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
    const pinned = await Promise.all(tasks.map(async t => {
      const project = this.deps.store.getProject(t.project);
      if (!project) throw new NotFound(`no project ${t.project}`);
      const resolve = (ref: string) => this.deps.run("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: project.path });
      const base = (await resolve(t.base).catch(() => resolve(`refs/remotes/origin/${t.base}`))).stdout.trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(base)) throw new Refused(`Could not pin ${t.base} to a commit.`, 400);
      return { ...t, base, kind: t.kind ?? (["claude-code", "codex"].includes(t.agent) ? "cli" as const : "acp" as const) };
    }));
    const result: BenchResult = { id: randomUUID(), startedAt: new Date().toISOString(), finishedAt: null, tasks: pinned.map(t => ({ task: t.task, project: t.project, base: t.base, agent: t.agent, model: t.model ?? null, kind: t.kind, runs: [] })) };
    await this.save(result);
    void (async () => {
      for (const [i, t] of pinned.entries()) {
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
    const row: BenchRun = { lane: null, baseline, tokens: null, minutes: null, passed: null, state: "running", detail: null };
    progress(row);
    const started = Date.now();
    try {
      const lane = await lanes.start({ project: t.project, task: t.task, agent: t.agent, kind: t.kind, model: t.model, base: t.base, mode: "edits", goal: `Bench ${baseline ? "baseline" : "enhanced"}`, baseline });
      row.lane = lane.id; progress(row);
      const deadline = started + t.timeoutMinutes * 60_000;
      // Stop is the native completion signal. A newer active turn or queued input keeps the run open.
      for (;;) {
        const events = this.all(lane.id);
        const turn = events.findLast((e): e is Extract<LaneEvent, { type: "agent.turn" }> => e.type === "agent.turn");
        const queued = store.pendingCommands(lane.id).some(e => e.payload.command.kind === "prompt");
        const failed = store.getLane(lane.id)?.state === "failed";
        if ((turn && !turn.payload.active && !queued) || failed || Date.now() > deadline) {
          row.minutes = Math.round((Date.now() - started) / 6000) / 10;
          const turns = events.filter((e): e is Extract<LaneEvent, { type: "usage.turn" }> => e.type === "usage.turn");
          const known = turns.length && turns.every(e => e.payload.inputTokens !== null && e.payload.outputTokens !== null && (e.payload.source === "codex-log" || e.payload.cacheReadTokens !== null && e.payload.cacheWriteTokens !== null));
          row.tokens = known ? turns.reduce((n, e) => n + (e.payload.inputTokens ?? 0) + (e.payload.outputTokens ?? 0) + (e.payload.cacheReadTokens ?? 0) + (e.payload.cacheWriteTokens ?? 0), 0) : null;
          if (failed || Date.now() > deadline || turn?.payload.stopReason) throw new Error(failed ? "The lane failed." : turn?.payload.stopReason || `No result within ${t.timeoutMinutes} minutes.`);
          break;
        }
        await new Promise((r) => setTimeout(r, this.deps.poll ?? 5000));
      }
      row.state = "checking"; progress(row);
      const result = await oneshot(run, lane.worktree, t.check, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOST: "127.0.0.1", CONTEXTLANES_LANE: lane.id }, 600, sandbox(config));
      row.passed = result.ok; row.state = "done"; row.detail = result.ok ? null : result.output.trim().split("\n").slice(-3).join(" ").slice(0, 300);
    } catch (err) {
      row.minutes = Math.round((Date.now() - started) / 6000) / 10;
      row.state = "failed"; row.detail = err instanceof Error ? err.message : String(err);
    }
    progress(row);
    return row;
  }

  private all(lane: string): LaneEvent[] {
    const out: LaneEvent[] = [];
    for (;;) { const page = this.deps.store.events(lane, out.at(-1)?.seq ?? 0); if (!page.length) return out; out.push(...page); }
  }
}

