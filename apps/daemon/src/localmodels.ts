import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LocalJob, LocalModel, LocalModelStatus, LocalRole } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import { Refused } from "./lanes/manager.js";
import { parseGpus } from "./resources.js";
import type { Runner } from "./run.js";

/** A path under the endpoint's configured URL, keeping any base path it has (http://host/llm/ + v1/models). */
export const endpoint = (base: string, path: string) => new URL(path.replace(/^\//, ""), base.endsWith("/") ? base : `${base}/`);

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatResult = { text: string; inputTokens: number | null; outputTokens: number | null; model: string; ms: number };

/**
 * The owner's local models (Ollama, llama.cpp or anything OpenAI-compatible). One job at a time per
 * endpoint, since each endpoint is one GPU: a second job waits rather than slowing both or running the
 * card out of memory. Every call goes through the OpenAI-compatible chat API both servers provide.
 */
const MAX_WAITING = 20;
/** Completion tokens allowed for a reasoning model's thinking, on top of the answer's own budget. */
const THINKING_ROOM = 4096;

/** The JSON object in a model's answer: without code fences, and without any prose before or after it. */
export function jsonAnswer(text: string): unknown {
  const bare = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(bare); } catch { /* Prose around the object, below. */ }
  const start = bare.indexOf("{"), end = bare.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(bare.slice(start, end + 1)); } catch { return null; }
}
const WAIT_MS = 10 * 60_000;

type ChatOptions = { maxTokens?: number; json?: boolean; timeoutMs?: number; role?: LocalRole };
/** Jobs kept in the journal: enough for "today" and the last failure, small enough to rewrite each time. */
const JOURNAL = 300;

export class LocalModels {
  private queues = new Map<string, { tail: Promise<unknown>; waiting: number; running: boolean; role: LocalRole | null }>();
  private jobs: LocalJob[] = [];
  private saving: Promise<void> = Promise.resolve();
  /** `journal`: a file that keeps the job record across restarts (the daemon passes one; tests do not). */
  constructor(private deps: { config: Config; run: Runner; fetch?: typeof fetch; journal?: string; now?: () => number }) {
    if (deps.journal) try { this.jobs = (JSON.parse(readFileSync(deps.journal, "utf8")) as LocalJob[]).slice(-JOURNAL); } catch { /* No record yet. */ }
  }
  private now() { return this.deps.now?.() ?? Date.now(); }

  /** Every job, kept so the Models page can say what each endpoint has actually done. */
  private record(job: LocalJob): void {
    this.jobs = [...this.jobs, job].slice(-JOURNAL);
    const file = this.deps.journal;
    if (!file) return;
    const text = JSON.stringify(this.jobs);
    this.saving = this.saving.then(async () => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(`${file}.tmp`, text, { mode: 0o600 }); await rename(`${file}.tmp`, file);
    }).catch((err: Error) => console.error(`Local model journal not saved: ${err.message}`));
  }
  /** The recorded jobs, oldest first. */
  history(): LocalJob[] { return [...this.jobs]; }

  list(): LocalModel[] { return this.deps.config.localModels; }
  private seen = new Map<string, { at: number; ok: boolean }>();
  /** Whether the endpoint answers at all, remembered for a minute. */
  async reachable(model: LocalModel): Promise<boolean> {
    const hit = this.seen.get(model.url);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    const ok = await (this.deps.fetch ?? fetch)(endpoint(model.url, model.provider === "ollama" ? "/api/tags" : "/health"), { signal: AbortSignal.timeout(2000), redirect: "error" }).then((r) => r.ok, () => false);
    this.seen.set(model.url, { at: Date.now(), ok });
    return ok;
  }
  /** Endpoints that take a job: those given the role, or with no roles at all; optionally only one model. */
  candidates(role: LocalRole, name?: string): LocalModel[] {
    return this.list().filter((m) => (!m.roles?.length || m.roles.includes(role)) && (!name || m.name === name));
  }
  /** Whether any endpoint is set up for a job (no network). */
  pick(role: LocalRole, name?: string): LocalModel | null { return this.candidates(role, name)[0] ?? null; }
  /**
   * The endpoint to run a job on: among those with the role, the answering one with the shortest queue,
   * so the same model on two machines shares the work and one that is down is skipped. When none answers,
   * the first, so the error names it.
   */
  async forJob(role: LocalRole, name?: string): Promise<LocalModel | null> {
    const all = this.candidates(role, name);
    const up = (await Promise.all(all.map(async (m) => (await this.reachable(m)) ? m : null))).filter((m): m is LocalModel => !!m);
    const load = (m: LocalModel) => { const q = this.queue(m.url); return q.waiting + (q.running ? 1 : 0); };
    return up.sort((a, b) => load(a) - load(b))[0] ?? all[0] ?? null;
  }

  private queue(url: string) {
    const key = new URL(url).host;
    let q = this.queues.get(key);
    if (!q) { q = { tail: Promise.resolve(), waiting: 0, running: false, role: null }; this.queues.set(key, q); }
    return q;
  }

  /**
   * Runs `job` when the endpoint's GPU is free. The queue is bounded: past MAX_WAITING jobs a new one is
   * refused at once, and a job that waited longer than `waitMs` gives up (its caller hears why) and is
   * skipped when its turn comes, so a slow model never piles up work nobody is waiting for any more.
   */
  async exclusive<T>(model: LocalModel, job: () => Promise<T>, waitMs = WAIT_MS, role: LocalRole | null = null): Promise<T> {
    const q = this.queue(model.url);
    if (q.waiting >= MAX_WAITING) throw new Refused(`${model.name} at ${new URL(model.url).host} already has ${q.waiting} jobs waiting. Try again when they finish, or add another endpoint for this role.`, 503);
    q.waiting++;
    let gaveUp = false, started = false;
    const result = q.tail.catch(() => {}).then(async () => {
      q.waiting--;
      if (gaveUp) throw new Refused("skipped: its caller stopped waiting", 503);
      started = true;
      q.running = true; q.role = role;
      try { return await job(); } finally { q.running = false; q.role = null; }
    });
    q.tail = result.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      // Only waiting counts: a job that has started runs to its own timeout.
      timer = setTimeout(() => { if (started) return; gaveUp = true; reject(new Refused(`${model.name} was busy for ${Math.round(waitMs / 60_000)} minutes with other jobs, so this one was dropped. Try again later.`, 503)); }, waitMs);
      timer.unref?.();
    });
    try { return await Promise.race([result, timeout]); } finally { clearTimeout(timer); }
  }

  /**
   * One chat completion. `maxTokens` is the answer's budget: reasoning models (gpt-oss, qwen3, deepseek-r1)
   * spend completion tokens on thinking first, so the request allows room for that on top, and gpt-oss is
   * asked to think briefly. JSON mode is a request, not a promise: an endpoint that refuses it is asked
   * again without it, and callers read the answer with `jsonAnswer`. An empty answer is an error that says why.
   */
  async chat(model: LocalModel, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const asked = this.now();
    const job = { role: opts.role ?? null, model: model.name, host: new URL(model.url).host };
    try {
      const result = await this.send(model, messages, opts);
      this.record({ ...job, at: new Date(asked).toISOString(), ms: result.ms, ok: true, error: null, outputTokens: result.outputTokens });
      return result;
    } catch (err) {
      this.record({ ...job, at: new Date(asked).toISOString(), ms: this.now() - asked, ok: false, error: (err as Error).message.slice(0, 300), outputTokens: null });
      throw err;
    }
  }

  private send(model: LocalModel, messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    return this.exclusive(model, async () => {
      const started = Date.now();
      const host = new URL(model.url).host;
      const send = (json: boolean) => (this.deps.fetch ?? fetch)(endpoint(model.url, "/v1/chat/completions"), {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
        body: JSON.stringify({ model: model.name, messages, temperature: 0.2, stream: false,
          ...(opts.maxTokens ? { max_tokens: opts.maxTokens + THINKING_ROOM } : {}),
          ...(/gpt-oss/i.test(model.name) ? { reasoning_effort: "low" } : {}),
          ...(json ? { response_format: { type: "json_object" } } : {}) }),
      }).catch((err: Error) => { throw new Refused(`${model.name} at ${host} did not answer: ${err.message}`, 503); });
      let res = await send(!!opts.json);
      if (!res.ok && opts.json && res.status >= 400 && res.status < 500) res = await send(false);
      if (!res.ok) throw new Refused(`${model.name} at ${host} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`, 503);
      const body = await res.json() as { choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
      // Reasoning models wrap their thinking in <think>, or return it in a separate field; only the answer is kept.
      const text = (body.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!text) throw new Refused(body.choices?.[0]?.finish_reason === "length"
        ? `${model.name} at ${host} used its whole token budget thinking and wrote no answer. Try a smaller model or one without long reasoning.`
        : `${model.name} at ${host} returned an empty answer.`, 503);
      return { text, inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null, model: body.model ?? model.name, ms: Date.now() - started };
    }, WAIT_MS, opts.role ?? null);
  }

  /**
   * `chat` with failover, as OpenRouter does across providers: when the chosen endpoint is down or errors,
   * the job goes to the next answering endpoint with the same role. The first error is the one reported.
   */
  async chatAny(role: LocalRole, first: LocalModel, messages: ChatMessage[], opts: Omit<ChatOptions, "role"> = {}): Promise<ChatResult> {
    opts = { ...opts, role } as ChatOptions;
    try { return await this.chat(first, messages, opts); }
    catch (err) {
      for (const next of this.candidates(role).filter((m) => m.url !== first.url || m.name !== first.name)) {
        if (!(await this.reachable(next))) continue;
        try { return await this.chat(next, messages, opts); } catch { /* Try the next one; the first error is reported. */ }
      }
      throw err;
    }
  }

  /** For the Models page: what each endpoint serves, what is loaded, and how full this machine's GPU is. */
  async status(): Promise<LocalModelStatus[]> {
    const f = this.deps.fetch ?? fetch;
    const get = (m: LocalModel, path: string) => f(endpoint(m.url, path), { signal: AbortSignal.timeout(4000), redirect: "error" }).then(async (r) => r.ok ? r.json() as Promise<Record<string, unknown>> : null, () => null);
    const gpus = await this.deps.run("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 5000 }).then((r) => parseGpus(r.stdout), () => []);
    return Promise.all(this.list().map(async (m): Promise<LocalModelStatus> => {
      const local = ["127.0.0.1", "localhost"].includes(new URL(m.url).hostname);
      const q = this.queue(m.url);
      const gpu = local && gpus[0] ? { name: gpus[0].name, totalMb: gpus[0].memoryTotalMiB ?? 0, usedMb: gpus[0].memoryUsedMiB ?? 0 } : null;
      const host = new URL(m.url).host;
      const mine = this.jobs.filter((j) => j.host === host && j.model === m.name);
      const midnight = new Date(this.now()); midnight.setHours(0, 0, 0, 0);
      const today = mine.filter((j) => Date.parse(j.at) >= midnight.getTime());
      const base = { name: m.name, provider: m.provider, url: m.url, label: m.label ?? null, roles: m.roles ?? [], local, gpu, waiting: q.waiting, running: q.running,
        current: q.running ? q.role : null, lastJob: mine.at(-1) ?? null, lastFailure: mine.findLast((j) => !j.ok) ?? null,
        today: { jobs: today.length, failed: today.filter((j) => !j.ok).length } };
      // Loaded is not the same as working: Ollama keeps a model in memory long after its last job.
      const up = q.running ? "working" as const : "ready" as const;
      if (m.provider === "ollama") {
        const [tags, ps] = await Promise.all([get(m, "/api/tags"), get(m, "/api/ps")]);
        if (!tags) return { ...base, state: "down", loaded: [], memory: null, detail: "Ollama did not answer." };
        const has = ((tags.models ?? []) as { name: string }[]).some((x) => x.name === m.name || x.name === `${m.name}:latest`);
        const loaded = ((ps?.models ?? []) as { name: string; size_vram?: number }[]);
        const vram = loaded.reduce((n, x) => n + (x.size_vram ?? 0), 0);
        return { ...base, state: up, loaded: loaded.map((x) => x.name), memory: vram || null,
          detail: has ? null : `${m.name} is not pulled. Run: ollama pull ${m.name}` };
      }
      const health = await f(endpoint(m.url, "/health"), { signal: AbortSignal.timeout(4000), redirect: "error" }).then((r) => r.ok, () => false);
      if (!health) return { ...base, state: "down", loaded: [], memory: null, detail: "The server did not answer." };
      const models = await get(m, "/v1/models");
      return { ...base, state: up, loaded: ((models?.data ?? []) as { id: string }[]).map((x) => x.id), memory: null, detail: null };
    }));
  }
}
