import { fileURLToPath } from "node:url";
import { assign, CodeMap, type LaneOverlay, type ProjectId, type ProjectMap } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { NotFound } from "./lanes/manager.js";
import { readRecipe } from "./recipes.js";
import type { Runner } from "./run.js";
import { sandbox } from "./sandbox.js";

export const CODEMAP_WORKER = fileURLToPath(new URL("./codemap-worker.js", import.meta.url));
const OPEN = ["setting_up", "working", "needs_you", "in_review", "failed", "paused"];

/**
 * The project's code map (CodeGraph, run by codemap-worker in the sandbox) and where each open lane
 * is on it. The index syncs on request, at most every 20 seconds, so the map is never older than that
 * when someone looks at it.
 */
export class CodeMaps {
  private cache = new Map<ProjectId, { at: number; map: CodeMap | null; error: string | null }>();
  private running = new Map<ProjectId, Promise<void>>();
  constructor(private deps: { run: Runner; store: Store; config: Config; worker?: string; maxAgeMs?: number }) {}

  async map(project: ProjectId): Promise<{ map: CodeMap | null; error: string | null }> {
    const p = this.deps.store.getProject(project);
    if (!p) throw new NotFound("no such project");
    const cached = this.cache.get(project);
    if (cached && Date.now() - cached.at < (this.deps.maxAgeMs ?? 20_000)) return cached;
    let job = this.running.get(project);
    if (!job) {
      job = this.build(project, p.path).finally(() => this.running.delete(project));
      this.running.set(project, job);
    }
    // A first build can take a while on a big repository; a later one returns the last map meanwhile.
    if (cached?.map) return cached;
    await job;
    return this.cache.get(project)!;
  }

  private async build(project: ProjectId, root: string): Promise<void> {
    const { run, config, store } = this.deps;
    const view = await readRecipe(store, store.getProject(project)!, root).catch(() => null);
    const arch = view?.recipe?.architecture ? JSON.stringify(view.recipe.architecture) : "";
    const [bin, ...wrap] = sandbox(config);
    try {
      const out = await run(bin!, [...wrap, process.execPath, this.deps.worker ?? CODEMAP_WORKER, root, arch], { timeout: 600_000, env: { CODEGRAPH_TELEMETRY: "0", DO_NOT_TRACK: "1", NODE_NO_WARNINGS: "1" } });
      this.cache.set(project, { at: Date.now(), map: CodeMap.parse(JSON.parse(out.stdout)), error: null });
    } catch (err) {
      const detail = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "";
      const previous = this.cache.get(project)?.map ?? null;
      this.cache.set(project, { at: Date.now(), map: previous, error: `The code map could not be built. ${detail}`.trim() });
    }
  }

  /** Files each open lane changed (committed since its base, and not yet committed), placed on the map. */
  async overlay(project: ProjectId, map: CodeMap): Promise<LaneOverlay[]> {
    const { store, run } = this.deps;
    const known = new Set(map.modules.map((m) => m.id));
    const lanes = store.listLanes(project).filter((l) => OPEN.includes(l.state));
    return Promise.all(lanes.map(async (lane) => {
      const base = await run("git", ["merge-base", lane.base ?? "HEAD", "HEAD"], { cwd: lane.worktree }).then((r) => r.stdout.trim(), () => "");
      const committed = base ? await run("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], { cwd: lane.worktree }).then((r) => r.stdout, () => "") : "";
      const pending = await run("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: lane.worktree }).then((r) => r.stdout.split("\0").filter(Boolean).map((l) => l.slice(3)).join("\n"), () => "");
      const modules: Record<string, string[]> = {};
      for (const file of new Set(`${committed}\n${pending}`.split("\n").filter(Boolean))) {
        const a = assign(file, map.rules);
        if (a) (modules[a.module] ??= []).push(file);
      }
      return { lane: lane.id, modules, created: Object.keys(modules).filter((m) => !known.has(m)) };
    }));
  }

  async project(project: ProjectId): Promise<ProjectMap> {
    const { map, error } = await this.map(project);
    return { map, error, lanes: map ? await this.overlay(project, map) : [] };
  }
}
