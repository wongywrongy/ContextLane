import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assign, estimateTokens, Suggestion, SuggestionAction, SuggestionType, type InsightStat, type InsightsView, type Lane, type LaneEvent, type ProjectId } from "@contextlanes/protocol";
import type { Briefs } from "./briefs.js";
import type { EventBus } from "./bus.js";
import type { CodeMaps } from "./codemap.js";
import type { Config } from "./config.js";
import type { Store } from "./db/store.js";
import { NotFound, Refused } from "./lanes/manager.js";
import type { LocalModels } from "./localmodels.js";

const DAY = 86400_000;
const ModelOutput = z.object({
  summary: z.array(z.object({ text: z.string().min(1).max(300), cites: z.array(z.string()).max(6).default([]) })).max(4).default([]),
  suggestions: z.array(z.object({ type: SuggestionType, title: z.string().min(1).max(120), body: z.string().min(1).max(400), stat: z.string(), evidence: z.array(z.string()).min(1).max(8), action: SuggestionAction })).max(8).default([]),
});
type Saved = { generatedAt: string; model: string; summary: InsightsView["summary"]; suggestions: Suggestion[] };
const k = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

/**
 * Insights: what the last week of lanes says about a project. Every number is computed here from the
 * event log, git (through the code map) and usage; the local model only writes sentences and
 * suggestions, each citing stat ids it was given. A sentence with a number no cited stat holds, or a
 * suggestion citing evidence that does not exist, is dropped. Nothing is applied without a click.
 */
export class Insights {
  private running = new Map<ProjectId, Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private due = new Map<ProjectId, number>();
  constructor(private deps: { config: Config; store: Store; bus: EventBus; models: LocalModels; codemaps: CodeMaps; briefs: Briefs; now?: () => number }) {}

  private now() { return this.deps.now?.() ?? Date.now(); }
  private file(project: ProjectId) { return join(this.deps.config.paths.data, "insights", `${project}.json`); }
  private async saved(project: ProjectId): Promise<Saved | null> { return readFile(this.file(project), "utf8").then((t) => JSON.parse(t) as Saved, () => null); }
  private async save(project: ProjectId, s: Saved) {
    await mkdir(join(this.deps.config.paths.data, "insights"), { recursive: true, mode: 0o700 });
    await writeFile(`${this.file(project)}.tmp`, JSON.stringify(s), { mode: 0o600 }); await rename(`${this.file(project)}.tmp`, this.file(project));
  }

  /** Nightly (after 02:00, once a day) and five minutes after a merge, for every project. */
  start(): void {
    this.deps.bus.subscribeAll((e) => { if (e.type === "lane.state" && e.payload.to === "merged") { const lane = this.deps.store.getLane(e.lane); if (lane) this.due.set(lane.project, this.now() + 5 * 60_000); } });
    this.timer = setInterval(() => void this.tick().catch((err) => console.error("Insights failed:", err)), 60_000);
    this.timer.unref();
  }
  close(): void { if (this.timer) clearInterval(this.timer); }
  private tried = new Map<string, number>();
  private async tick(): Promise<void> {
    if (!this.deps.models.pick("insights")) return;
    for (const p of this.deps.store.listProjects()) {
      const last = (await this.saved(p.id))?.generatedAt;
      // A failed run (model down) waits 6 hours before the nightly one tries again, not a minute.
      const tried = this.tried.get(p.id) ?? 0;
      const nightly = new Date(this.now()).getHours() >= 2 && (!last || this.now() - Date.parse(last) > 20 * 3600_000) && this.now() - tried > 6 * 3600_000;
      const afterMerge = (this.due.get(p.id) ?? Infinity) <= this.now();
      if (nightly || afterMerge) { this.due.delete(p.id); this.tried.set(p.id, this.now()); await this.generate(p.id).catch(() => {}); }
    }
  }

  private events(lanes: Lane[], since: number): LaneEvent[] {
    return this.deps.store.eventsSince(lanes.map((l) => l.id), new Date(since).toISOString());
  }

  /** The week's facts and the evidence stats the model may cite. */
  async measure(project: ProjectId): Promise<Pick<InsightsView, "week" | "facts" | "stats" | "today" | "startsWith">> {
    const { store } = this.deps;
    if (!store.getProject(project)) throw new NotFound("no such project");
    const now = this.now(); const since = now - 7 * DAY;
    const lanes = store.listLanes(project);
    const events = this.events(lanes, since);
    const lane = (id: string) => lanes.find((l) => l.id === id);
    const n = (id: string) => id.slice(id.lastIndexOf("/") + 1);
    const merges = events.filter((e) => e.type === "lane.state" && e.payload.to === "merged");
    const turns = events.filter((e): e is Extract<LaneEvent, { type: "usage.turn" }> => e.type === "usage.turn");
    const cloud = turns.reduce((s, e) => s + (e.payload.inputTokens ?? 0) + (e.payload.outputTokens ?? 0) + (e.payload.cacheReadTokens ?? 0) + (e.payload.cacheWriteTokens ?? 0), 0);
    const helped = events.filter((e): e is Extract<LaneEvent, { type: "helper.delegated" }> => e.type === "helper.delegated");
    const local = helped.reduce((s, e) => s + e.payload.tokensSaved + (e.payload.resultTokens ?? 0), 0);
    const asks = events.filter((e): e is Extract<LaneEvent, { type: "permission.requested" }> => e.type === "permission.requested");
    const waits = asks.flatMap((a) => { const ans = events.find((e) => e.type === "permission.answered" && e.lane === a.lane && e.payload.requestId === a.payload.requestId); return ans ? [(Date.parse(ans.at) - Date.parse(a.at)) / 60_000] : []; });
    const stats: InsightStat[] = [];
    const add = (s: InsightStat) => { stats.push(s); return s.id; };
    add({ id: "merges", label: "merges", value: String(merges.length), detail: merges.map((m) => `lane ${n(m.lane)}`).join(", ") || "none" });
    add({ id: "cloud", label: "cloud tokens", value: k(cloud), detail: `${turns.length} agent turns with reported usage` });
    // Questions the agents asked, grouped by wording: the same question twice is a missing project note.
    const questions = new Map<string, Extract<LaneEvent, { type: "permission.requested" }>[]>();
    for (const a of asks.filter((x) => x.payload.kind === "question")) { const key = a.payload.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").filter((w) => w.length > 3).slice(0, 6).join(" "); questions.set(key, [...(questions.get(key) ?? []), a]); }
    for (const [, qs] of [...questions].filter(([, qs]) => qs.length >= 2).slice(0, 3)) add({ id: `question:${qs[0]!.seq}`, label: "asks", value: String(qs.length), detail: `"${qs[0]!.payload.title}" asked ${qs.length} times by lane ${[...new Set(qs.map((q) => n(q.lane)))].join(", ")}` });
    // Files read again and again across lanes, and what that cost.
    const reads = new Map<string, Set<string>>(); const readCount = new Map<string, number>();
    for (const e of events) if (e.type === "tool.call" && e.payload.kind === "read") for (const f of e.payload.files) { const rel = lane(e.lane) ? f.replace(`${lane(e.lane)!.worktree}/`, "") : f; reads.set(rel, (reads.get(rel) ?? new Set()).add(e.lane)); readCount.set(rel, (readCount.get(rel) ?? 0) + 1); }
    for (const [file, count] of [...readCount].sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, c]) => c >= 4)) add({ id: `reads:${file}`, label: "reads", value: String(count), detail: `${file} read ${count} times by ${reads.get(file)!.size} lanes` });
    // Modules many lanes edit (from the code map), and collisions.
    const { map } = await this.deps.codemaps.map(project).catch(() => ({ map: null }));
    if (map) {
      const edits = new Map<string, Set<string>>();
      for (const e of events) if (e.type === "tool.call" && e.payload.kind === "edit") for (const f of e.payload.files) { const rel = lane(e.lane) ? f.replace(`${lane(e.lane)!.worktree}/`, "") : f; const m = assign(rel, map.rules)?.module; if (m) edits.set(m, (edits.get(m) ?? new Set()).add(e.lane)); }
      for (const [m, ls] of [...edits].sort((a, b) => b[1].size - a[1].size).slice(0, 3).filter(([, ls]) => ls.size >= 2)) add({ id: `module:${m}`, label: "lanes touched it", value: String(ls.size), detail: `${m} edited by lanes ${[...ls].map(n).join(", ")}` });
    }
    const collisions = events.filter((e) => e.type === "collision.detected" && e.payload.order[1] === e.lane);
    if (collisions.length) add({ id: "collisions", label: "collisions", value: String(collisions.length), detail: collisions.map((c) => c.type === "collision.detected" ? `${c.payload.module} (${c.payload.lanes.map(n).join(" and ")})` : "").join(", ") });
    // Big tool outputs the lead read itself: candidates for the helper.
    for (const e of events.filter((x): x is Extract<LaneEvent, { type: "tool.update" }> => x.type === "tool.update" && !!x.payload.summary && x.payload.summary.length > 40_000).slice(0, 2)) add({ id: `output:${e.lane}#${e.seq}`, label: "tokens of output", value: k(estimateTokens(e.payload.summary!)), detail: `lane ${n(e.lane)} read ${k(estimateTokens(e.payload.summary!))} tokens of command output itself` });
    // Plan entries left pending in merged lanes: work nobody owns.
    for (const m of merges) { const plan = events.filter((e) => e.lane === m.lane && e.type === "agent.plan").at(-1); if (plan?.type === "agent.plan") for (const p of plan.payload.entries.filter((x) => x.status !== "completed").slice(0, 2)) add({ id: `plan:${m.lane}#${plan.seq}`, label: "task unowned", value: "1", detail: `"${p.text}" was left in lane ${n(m.lane)}'s plan when it merged` }); }
    if (waits.length) add({ id: "wait", label: "median wait for you", value: `${Math.round(median(waits)!)}m`, detail: `${waits.length} answered questions and permissions` });
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const byLane = new Map<string, { tokens: number; cache: number; input: number }>();
    for (const t of turns.filter((e) => Date.parse(e.at) >= today.getTime())) { const v = byLane.get(t.lane) ?? { tokens: 0, cache: 0, input: 0 }; v.tokens += (t.payload.inputTokens ?? 0) + (t.payload.outputTokens ?? 0) + (t.payload.cacheReadTokens ?? 0); v.cache += t.payload.cacheReadTokens ?? 0; v.input += (t.payload.inputTokens ?? 0) + (t.payload.cacheReadTokens ?? 0); byLane.set(t.lane, v); }
    const notes = await this.deps.briefs.notes(project);
    const briefs = await readdir(join(this.deps.config.paths.data, "briefs", project)).then((f) => f.filter((x) => x.endsWith(".json")).length, () => 0);
    const handoffs = await readdir(join(this.deps.config.paths.data, "handoffs", project)).then((f) => f.length, () => 0);
    return {
      week: { from: new Date(since).toISOString(), to: new Date(now).toISOString(), events: events.length, merges: merges.length },
      facts: { merges: merges.length, cloudTokens: cloud, localShare: cloud + local ? local / (cloud + local) : null, medianWaitMinutes: median(waits) },
      stats,
      today: [...byLane].map(([id, v]) => ({ lane: id, task: lane(id)?.task ?? id, tokens: v.tokens, cacheShare: v.input ? v.cache / v.input : null, local: false })).sort((a, b) => b.tokens - a.tokens),
      startsWith: { notes: { facts: notes.split("\n").filter((l) => l.trim()).length, tokens: estimateTokens(notes) }, briefs, handoffs },
    };
  }

  async view(project: ProjectId): Promise<InsightsView> {
    const measured = await this.measure(project);
    const saved = await this.saved(project);
    return { project, ...measured, generatedAt: saved?.generatedAt ?? null, model: saved?.model ?? null, error: null, canWrite: !!this.deps.models.pick("insights"),
      summary: saved?.summary ?? [], suggestions: (saved?.suggestions ?? []).filter((s) => !s.dismissed) };
  }

  /** Writes the summary and suggestions with the local model. One run per project at a time. */
  async generate(project: ProjectId): Promise<InsightsView> {
    const model = await this.deps.models.forJob("insights");
    if (!model) throw new Refused("Add a local model for Insights under Models to write insights.");
    let job = this.running.get(project);
    if (!job) {
      job = (async () => {
        const m = await this.measure(project);
        if (!m.stats.length) throw new Refused("Nothing happened in this project in the last week to write about.");
        const ids = new Set(m.stats.map((s) => s.id));
        const answer = await this.deps.models.chat(model, [
          { role: "system", content: `You write a weekly review of a software project's coding-agent lanes for its one developer. You are given computed stats, each with an id. Reply with JSON only:
{"summary":[{"text":"one or two plain sentences","cites":["stat id"]}],"suggestions":[{"type":"process|code|tokens|next|notes","title":"imperative, under 60 characters","body":"one sentence saying what was seen and why it matters","stat":"the stat id whose value is the suggestion's number","evidence":["stat ids"],"action":{"kind":"add_note","text":"the note"} | {"kind":"start_lane","task":"…"} | {"kind":"allow_helper","helper":"read|edit|check"} | {"kind":"review","lane":"project/NN"} | {"kind":"fix_note"}}]}
Rules: at most 2 summary items and 6 suggestions, biggest first. Every number you write must be a value from a cited stat. Only suggest what the stats show. Plain words, no hype.` },
          { role: "user", content: JSON.stringify(m.stats) },
        ], { json: true, maxTokens: 1500 });
        const raw = ModelOutput.safeParse((() => { try { return JSON.parse(answer.text.replace(/^```(?:json)?\n?|```$/g, "")); } catch { return null; } })());
        if (!raw.success) throw new Refused(`${model.name} did not return usable insights. Try Regenerate.`, 503);
        const values = (cites: string[]) => new Set(m.stats.filter((s) => cites.includes(s.id)).flatMap((s) => [s.value, ...`${s.value} ${s.detail}`.match(/\d[\d.,]*[kM]?/g) ?? []]));
        // A number in the text must be one the cited stats hold; otherwise the sentence is dropped.
        const honest = (text: string, cites: string[]) => (text.match(/\d[\d.,]*[kM]?/g) ?? []).every((num) => values(cites).has(num));
        const summary = raw.data.summary.filter((s) => s.cites.every((c) => ids.has(c)) && honest(s.text, s.cites));
        const suggestions = raw.data.suggestions.filter((s) => ids.has(s.stat) && s.evidence.every((e) => ids.has(e)) && honest(`${s.title} ${s.body}`, [s.stat, ...s.evidence]))
          .map((s) => Suggestion.parse({ ...s, id: randomUUID(), dismissed: false }));
        await this.save(project, { generatedAt: new Date(this.now()).toISOString(), model: answer.model, summary, suggestions });
      })().finally(() => this.running.delete(project));
      this.running.set(project, job);
    }
    await job;
    return this.view(project);
  }

  async dismiss(project: ProjectId, id: string): Promise<void> {
    const saved = await this.saved(project);
    if (!saved) throw new NotFound("no insights yet");
    await this.save(project, { ...saved, suggestions: saved.suggestions.map((s) => s.id === id ? { ...s, dismissed: true } : s) });
  }
}
