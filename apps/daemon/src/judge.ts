import { z } from "zod";
import type { Checkpoint, CheckpointJudge, JudgeFinding, LaneEvent } from "@contextlanes/protocol";
import type { EventBus } from "./bus.js";
import type { Store } from "./db/store.js";
import { NotFound, Refused } from "./lanes/manager.js";
import { jsonAnswer, type LocalModels } from "./localmodels.js";

/**
 * The review judge: a local model reads each checkpoint as it is made (summary, plan, checks and the diff)
 * and writes a verdict with the few things worth looking at, so Review leads with a read of the change rather
 * than counts. It never approves or merges; the owner decides. It costs no cloud tokens.
 *
 * Small models invent things, so what it says is checked before it is shown: every finding must name a file
 * the change touched, and a verdict of "merge" is lowered when checks failed or it reported a blocker.
 */
const DIFF_BUDGET = 18_000;
const FILE_BUDGET = 6_000;
/** Lockfiles, build output and minified files: large, generated, and nothing to judge. */
const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$|(^|\/)(dist|build|out|\.next|vendor|node_modules)\/|\.(min\.(js|css)|map|snap|svg|png|jpe?g|gif|webp|ico|pdf|lock)$/i;

const Answer = z.object({
  verdict: z.string(),
  headline: z.string(),
  findings: z.array(z.object({ severity: z.string(), file: z.string(), line: z.union([z.number(), z.string(), z.null()]).optional(), text: z.string() })).default([]),
});

const ORDER: Record<JudgeFinding["severity"], number> = { blocker: 0, "should fix": 1, nit: 2 };

/** The diff the judge reads: biggest changes first, generated files left out, each file and the whole kept to a budget. */
export function diffForJudge(diff: string): { text: string; skipped: string[] } {
  const blocks = diff.split(/(?=^diff --git )/m).filter((b) => b.startsWith("diff --git "));
  const file = (b: string) => /^diff --git a\/(.+?) b\//.exec(b)?.[1] ?? "";
  const skipped: string[] = [];
  const kept = blocks.filter((b) => { if (SKIP.test(file(b))) { skipped.push(file(b)); return false; } return true; })
    .sort((a, b) => b.length - a.length);
  let text = "";
  for (const b of kept) {
    const part = b.length > FILE_BUDGET ? `${b.slice(0, FILE_BUDGET)}\n… (rest of ${file(b)} not shown)\n` : b;
    if (text.length + part.length > DIFF_BUDGET) { skipped.push(file(b)); continue; }
    text += part;
  }
  return { text, skipped };
}

/** Checks what the model said against the checkpoint and returns only what can be shown. */
export function settle(raw: unknown, c: Checkpoint): Pick<CheckpointJudge, "verdict" | "headline" | "findings"> | null {
  const parsed = Answer.safeParse(raw);
  if (!parsed.success) return null;
  const paths = c.files.map((f) => f.path);
  const named = (f: string) => { const clean = f.replace(/^[ab]\//, "").replace(/:\d+$/, "").trim(); return paths.find((p) => p === clean || p.endsWith(`/${clean}`) || clean.endsWith(`/${p}`)) ?? null; };
  const severity = (s: string): JudgeFinding["severity"] | null => /block/i.test(s) ? "blocker" : /should|fix|major|high/i.test(s) ? "should fix" : /nit|minor|low|style/i.test(s) ? "nit" : null;
  const findings = parsed.data.findings.flatMap((f): JudgeFinding[] => {
    const file = named(f.file);
    const sev = severity(f.severity);
    const line = typeof f.line === "number" ? f.line : typeof f.line === "string" && /^\d+$/.test(f.line) ? Number(f.line) : null;
    return file && sev && f.text.trim() ? [{ severity: sev, file, line: line && line > 0 ? line : null, text: f.text.trim().slice(0, 300) }] : [];
  }).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]).slice(0, 6);
  const said = parsed.data.verdict.toLowerCase();
  let verdict: NonNullable<CheckpointJudge["verdict"]> = /not|don'?t|reject|block/.test(said) ? "do not merge" : /fix|after|change|needs/.test(said) ? "fix first" : "merge";
  // What the evidence says outranks the model's mood.
  if (verdict === "merge" && (findings.some((f) => f.severity === "blocker") || c.checks.some((x) => !x.passed))) verdict = "fix first";
  const headline = parsed.data.headline.trim().split("\n")[0]!.slice(0, 200) || null;
  return { verdict, headline, findings };
}

export class Judge {
  private running = new Set<string>();
  constructor(private deps: { store: Store; bus: EventBus; models: LocalModels; diff: (c: Checkpoint) => Promise<string>; now?: () => number }) {}

  /** Judges every new checkpoint as it is made. */
  start(): () => void {
    return this.deps.bus.subscribeAll((e: LaneEvent) => { if (e.type === "checkpoint.created") void this.judge(e.payload.checkpointId).catch((err: Error) => console.error(`Judging ${e.payload.checkpointId}: ${err.message}`)); });
  }

  private set(c: Checkpoint, judge: CheckpointJudge): void {
    const { store, bus } = this.deps;
    store.setJudge(c.id, judge);
    bus.publish(store.appendEvent(c.lane, { type: "checkpoint.judged", payload: { checkpointId: c.id, state: judge.state, verdict: judge.verdict } }));
  }

  /** "Judge again" on Review: starts in the background, refusing at once when it cannot run. */
  again(id: string): { started: true } {
    const c = this.deps.store.checkpoint(id);
    if (!c) throw new NotFound("no such checkpoint");
    if (c.decision) throw new Refused("This checkpoint has been decided already.");
    if (this.running.has(id)) throw new Refused("The judge is already reading this checkpoint.");
    void this.judge(id).catch((err: Error) => console.error(`Judging ${id}: ${err.message}`));
    return { started: true };
  }

  /** Judge (or judge again) one checkpoint. Resolves when the verdict is stored. */
  async judge(id: string): Promise<CheckpointJudge> {
    const { store, models } = this.deps;
    const c = store.checkpoint(id);
    if (!c) throw new NotFound("no such checkpoint");
    if (this.running.has(id)) throw new Refused("The judge is already reading this checkpoint.");
    const at = () => new Date(this.deps.now?.() ?? Date.now()).toISOString();
    const base = { model: null, verdict: null, headline: null, findings: [] as JudgeFinding[], error: null, skipped: [] as string[] };
    // The judge's own role, or the Insights model when no endpoint has it ticked.
    const model = await models.forJob("judge") ?? await models.forJob("insights");
    if (!model) { const off: CheckpointJudge = { ...base, state: "off", at: at() }; this.set(c, off); return off; }
    this.running.add(id);
    try {
      this.set(c, { ...base, state: "running", model: model.name, at: at() });
      const { text, skipped } = diffForJudge(await this.deps.diff(c));
      const facts = [
        `Summary from the agent: ${c.summary}`,
        c.plan.length ? `Its plan: ${c.plan.map((p) => `[${p.status === "completed" ? "done" : "open"}] ${p.text}`).join("; ")}` : "It wrote no plan.",
        c.checks.length ? `Checks: ${c.checks.map((x) => `${x.name} ${x.passed ? "passed" : `FAILED: ${x.detail.split("\n").slice(-3).join(" ").slice(0, 300)}`}`).join("; ")}` : "No checks are set up.",
        `Changed files: ${c.files.map((f) => `${f.path} (+${f.added} -${f.removed})`).join(", ")}`,
        skipped.length ? `Not shown below: ${skipped.join(", ")}` : "",
      ].filter(Boolean).join("\n");
      const ask = [
        { role: "system" as const, content: "You review a code change a coding agent made, before its owner merges it. Report only problems you can see in the diff: bugs, wrong logic, missing error handling at boundaries, security issues, changes the summary or plan does not explain, changed logic without tests, and leftovers (debug prints, commented-out code). No praise. Never invent files or line numbers. Answer with JSON only." },
        { role: "user" as const, content: `${facts}\n\nThe diff:\n${text || "(empty)"}\n\nAnswer as JSON: {"verdict": "merge" | "fix first" | "do not merge", "headline": "one sentence under 20 words: what the change does and whether it is safe", "findings": [{"severity": "blocker" | "should fix" | "nit", "file": "a path from the changed files", "line": number or null, "text": "what is wrong and why, under 30 words"}]}. At most 5 findings, most serious first; an empty list is fine.` },
      ];
      const answer = await models.chatAny("judge", model, ask, { json: true, maxTokens: 1500, timeoutMs: 240_000 });
      const settled = settle(jsonAnswer(answer.text), c);
      const done: CheckpointJudge = settled
        ? { ...base, state: "done", model: answer.model, ...settled, skipped, at: at() }
        : { ...base, state: "failed", model: answer.model, error: `${answer.model} did not return a usable review.`, skipped, at: at() };
      this.set(c, done);
      return done;
    } catch (err) {
      const failed: CheckpointJudge = { ...base, state: "failed", model: model.name, error: (err as Error).message.slice(0, 300), at: at() };
      this.set(c, failed);
      return failed;
    } finally { this.running.delete(id); }
  }
}
