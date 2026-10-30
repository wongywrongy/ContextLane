import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { estimateTokens, type HelperKind, type HelperStatus, type Lane, type LaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { Refused } from "./lanes/manager.js";
import type { LocalModels } from "./localmodels.js";
import type { Runner } from "./run.js";
import type { Runtime } from "./runtime.js";
import { oneshot } from "./runtime.js";
import { readInside } from "./safefs.js";
import { sandbox } from "./sandbox.js";

const KINDS: HelperKind[] = ["read", "edit", "check"];
const WINDOW = 20;
const MAX_FILE = 200_000;

/**
 * The local helper behind `delegate`. Each call is one bounded request to the local model, not an
 * agent loop: small models do well at "read these files and say what matters" and badly at long tool
 * loops. read answers from files; check runs the approved recipe's checks and sorts the failures;
 * edit returns a patch that the lead applies itself, so the helper never writes and the owner's
 * permissions still apply. A kind switches itself off when the lead keeps redoing its work.
 */
export class Helper {
  /** Delegations waiting for their lane's turn to end, to see whether the lead redid the work. */
  private pending = new Map<string, { seq: number; kind: HelperKind; files: string[]; command: string | null; patch: string | null; seen: LaneEvent[] }[]>();
  constructor(private deps: { config: Config; store: Store; bus: EventBus; models: LocalModels; run: Runner; runtime: Runtime }) {
    deps.bus.subscribeAll((e) => void this.observe(e).catch(() => {}));
  }

  private overridesFile() { return join(this.deps.config.paths.data, "helper.json"); }
  private async overrides(): Promise<Partial<Record<HelperKind, boolean>>> { return readFile(this.overridesFile(), "utf8").then((t) => JSON.parse(t), () => ({})); }

  /** Per kind, across all projects (one GPU, one helper): uses, redo rate over the last 20, cloud tokens saved this week, and whether it is on. */
  async status(): Promise<HelperStatus[]> {
    const limit = this.deps.config.helper.redoLimit;
    const overrides = await this.overrides();
    const chosen = await this.deps.models.forJob("helper", this.deps.config.helper.model);
    const model = chosen ?? this.deps.models.pick("helper", this.deps.config.helper.model);
    const answering = chosen ? await this.deps.models.reachable(chosen) : false;
    const events = this.events();
    const weekAgo = Date.now() - 7 * 86400_000;
    return KINDS.map((kind) => {
      const uses = events.filter((e): e is Extract<LaneEvent, { type: "helper.delegated" }> => e.type === "helper.delegated" && e.payload.kind === kind);
      const recent = uses.slice(-WINDOW);
      const redone = recent.filter((u) => events.some((e) => e.type === "helper.redone" && e.lane === u.lane && e.payload.seq === u.seq)).length;
      const rate = recent.length ? redone / recent.length : 0;
      const auto = recent.length >= 5 && rate > limit ? "off" : recent.length >= 5 && rate > limit - 0.05 ? "near" : "on";
      const owner = overrides[kind];
      const state = !model || !answering ? "off" : owner === false ? "off" : owner === true ? (auto === "off" ? "near" : auto) : auto;
      return { kind, model: model?.name ?? null, uses: uses.length, redoneRate: recent.length ? rate : null, savedThisWeek: uses.filter((u) => Date.parse(u.at) > weekAgo).reduce((n, u) => n + u.payload.tokensSaved, 0),
        state, reason: !model ? "No local model is set up." : !answering ? `${model.name} is not answering.` : owner === false ? "Turned off by you." : auto === "off" && owner !== true ? `Redone ${Math.round(rate * 100)}% of the last ${recent.length} times (limit ${Math.round(limit * 100)}%).` : null };
    });
  }

  async setKind(kind: HelperKind, on: boolean): Promise<void> {
    const all = { ...await this.overrides(), [kind]: on };
    await mkdir(this.deps.config.paths.data, { recursive: true });
    await writeFile(`${this.overridesFile()}.tmp`, JSON.stringify(all), { mode: 0o600 });
    await rename(`${this.overridesFile()}.tmp`, this.overridesFile());
  }

  /** Whether delegate is worth offering to agents at all. */
  async available(): Promise<boolean> { return (await this.status()).some((s) => s.state !== "off"); }

  private async read(lane: Lane, files: string[]): Promise<string> {
    const parts: string[] = [];
    for (const f of files.slice(0, 20)) {
      const textual = resolve(lane.worktree, f);
      if (textual !== lane.worktree && !textual.startsWith(lane.worktree + sep)) throw new Refused(`${f} is outside this lane's checkout.`);
      // Through readInside: the agent controls the checkout, so a symlink to the data folder or a FIFO is refused.
      const file = await readInside(lane.worktree, f, MAX_FILE + 1);
      if (!file) { parts.push(`--- ${f}\n(not found, outside this checkout, or not a regular file)`); continue; }
      parts.push(`--- ${f}\n${file.size > MAX_FILE ? `${file.text.slice(0, MAX_FILE / 2)}\n[… ${file.size - MAX_FILE / 2} bytes left out …]` : file.text}`);
    }
    return parts.join("\n\n");
  }

  async delegate(lane: Lane, body: { kind: HelperKind; task: string; files: string[] }): Promise<{ result: string; tokensSaved: number }> {
    const status = (await this.status()).find((s) => s.kind === body.kind)!;
    if (status.state === "off") throw new Refused(`The local helper's ${body.kind} is off: ${status.reason ?? "turned off"} Do this yourself.`);
    const model = (await this.deps.models.forJob("helper", this.deps.config.helper.model))!;
    let input = ""; let command: string | null = null; let prompt: string;
    if (body.kind === "check") {
      const recipe = await this.deps.runtime.recipeFor(lane).catch(() => null);
      const checks = recipe?.checks ?? [];
      if (!checks.length) throw new Refused("This lane's approved recipe has no checks to run. Run the tests yourself.");
      const outputs: string[] = [];
      for (const c of checks) {
        const r = await oneshot(this.deps.run, lane.worktree, c.command, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOST: "127.0.0.1", CONTEXTLANES_LANE: lane.id }, c.timeoutSeconds, sandbox(this.deps.config));
        outputs.push(`=== ${c.name} (${c.command.join(" ")}): ${r.ok ? "passed" : "FAILED"} in ${Math.round(r.ms / 100) / 10}s\n${r.output}`);
      }
      command = checks.map((c) => c.command.join(" ")).join(" && ");
      input = outputs.join("\n\n");
      prompt = `Checks were run for: ${body.task || "the lane's recipe"}.\nList each failing test or error as "file:line — what failed — the likely cause", most important first, then one line per check saying passed or failed. Leave out passing output and noise.\n\n${input}`;
    } else {
      if (!body.files.length) throw new Refused("Name the files for the helper to read.");
      input = await this.read(lane, body.files);
      prompt = body.kind === "read"
        ? `Task from the lead agent: ${body.task}\nAnswer from these files only. Quote the exact lines that matter with file:line, and keep it short.\n\n${input}`
        : `Task from the lead agent: ${body.task}\nReturn only a unified diff (git format, paths relative to the repository root, a/ and b/ prefixes) that makes this change and nothing else. No explanation.\n\n${input}`;
    }
    const answer = await this.deps.models.chat(model, [{ role: "system", content: "You help a coding agent by doing one bounded job on a local machine. Be exact and brief." }, { role: "user", content: prompt }], { maxTokens: body.kind === "edit" ? 4000 : 1500 });
    let result = answer.text;
    let patch: string | null = null;
    if (body.kind === "edit") {
      patch = (/```(?:diff|patch)?\n([\s\S]*?)```/.exec(result)?.[1] ?? result).trim() + "\n";
      const dir = join(this.deps.config.paths.lanes, ".attachments", lane.id.replace("/", "-"));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `helper-${Date.now()}.patch`);
      await writeFile(file, patch, { mode: 0o600 });
      const applies = await this.deps.run("git", ["apply", "--check", file], { cwd: lane.worktree }).then(() => true, () => false);
      result = applies ? `This patch applies cleanly. Review it, then apply it yourself (for example: git apply ${file}).\n\n${patch}` : `The helper's patch does not apply to the current files; make the change yourself.\n\n${patch}`;
    }
    const tokensSaved = Math.max(0, estimateTokens(input) - estimateTokens(result));
    const e = this.deps.store.appendEvent(lane.id, { type: "helper.delegated", payload: { kind: body.kind, model: answer.model, tokensSaved, task: body.task.slice(0, 300), files: body.files.slice(0, 20), resultTokens: estimateTokens(result), ms: answer.ms } });
    this.deps.bus.publish(e);
    this.pending.set(lane.id, [...(this.pending.get(lane.id) ?? []), { seq: e.seq, kind: body.kind, files: body.files, command, patch, seen: [] }]);
    return { result, tokensSaved };
  }

  /** Redone means: read — the lead reads the same files itself in that turn; check — it runs the same command; edit — the patch was never applied. */
  private async observe(e: LaneEvent): Promise<void> {
    const waiting = this.pending.get(e.lane);
    if (!waiting?.length) return;
    if (e.type !== "agent.turn" || e.payload.active) { for (const w of waiting) if (e.seq > w.seq) w.seen.push(e); return; }
    this.pending.delete(e.lane);
    const lane = this.deps.store.getLane(e.lane);
    for (const w of waiting) {
      const calls = w.seen.filter((x): x is Extract<LaneEvent, { type: "tool.call" }> => x.type === "tool.call");
      let redone = false;
      if (w.kind === "read") redone = calls.some((c) => c.payload.kind === "read" && c.payload.files.some((f) => w.files.some((g) => f.endsWith(g))));
      if (w.kind === "check") redone = !!w.command && calls.some((c) => c.payload.kind === "execute" && w.command!.split(" && ").some((cmd) => c.payload.title.includes(cmd)));
      if (w.kind === "edit" && w.patch && lane) {
        const dir = join(this.deps.config.paths.lanes, ".attachments", lane.id.replace("/", "-"));
        const file = join(dir, `redo-${w.seq}.patch`);
        await writeFile(file, w.patch, { mode: 0o600 });
        redone = !(await this.deps.run("git", ["apply", "--reverse", "--check", file], { cwd: lane.worktree }).then(() => true, () => false));
      }
      if (redone) this.deps.bus.publish(this.deps.store.appendEvent(e.lane, { type: "helper.redone", payload: { seq: w.seq, kind: w.kind } }));
    }
  }

  private events(): LaneEvent[] {
    const out: LaneEvent[] = [];
    for (const lane of this.deps.store.listLanes()) {
      let after = 0;
      for (;;) { const page = this.deps.store.events(lane.id, after); if (!page.length) break; out.push(...page.filter((e) => e.type === "helper.delegated" || e.type === "helper.redone")); after = page.at(-1)!.seq; }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }
}
