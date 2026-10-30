import type { LocalModel, LocalModelStatus } from "@contextlanes/protocol";
import type { Config } from "./config.js";
import { Refused } from "./lanes/manager.js";
import { parseGpus } from "./resources.js";
import type { Runner } from "./run.js";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatResult = { text: string; inputTokens: number | null; outputTokens: number | null; model: string; ms: number };

/**
 * The owner's local models (Ollama, llama.cpp or anything OpenAI-compatible). One job at a time per
 * endpoint, since each endpoint is one GPU: a second job waits rather than slowing both or running the
 * card out of memory. Every call goes through the OpenAI-compatible chat API both servers provide.
 */
export class LocalModels {
  private queues = new Map<string, { tail: Promise<unknown>; waiting: number; running: boolean }>();
  constructor(private deps: { config: Config; run: Runner; fetch?: typeof fetch }) {}

  list(): LocalModel[] { return this.deps.config.localModels; }
  private seen = new Map<string, { at: number; ok: boolean }>();
  /** Whether the endpoint answers at all, remembered for a minute. */
  async reachable(model: LocalModel): Promise<boolean> {
    const hit = this.seen.get(model.url);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    const ok = await (this.deps.fetch ?? fetch)(new URL(model.provider === "ollama" ? "/api/tags" : "/health", model.url), { signal: AbortSignal.timeout(2000), redirect: "error" }).then((r) => r.ok, () => false);
    this.seen.set(model.url, { at: Date.now(), ok });
    return ok;
  }
  /** The configured model for a job, or null when there is none to use. */
  pick(name?: string): LocalModel | null { const all = this.list(); return (name ? all.find((m) => m.name === name) : all[0]) ?? null; }

  private queue(url: string) {
    const key = new URL(url).host;
    let q = this.queues.get(key);
    if (!q) { q = { tail: Promise.resolve(), waiting: 0, running: false }; this.queues.set(key, q); }
    return q;
  }

  /** Runs `job` when the endpoint's GPU is free. */
  async exclusive<T>(model: LocalModel, job: () => Promise<T>): Promise<T> {
    const q = this.queue(model.url);
    q.waiting++;
    const result = q.tail.catch(() => {}).then(async () => { q.waiting--; q.running = true; try { return await job(); } finally { q.running = false; } });
    q.tail = result;
    return result;
  }

  async chat(model: LocalModel, messages: ChatMessage[], opts: { maxTokens?: number; json?: boolean; timeoutMs?: number } = {}): Promise<ChatResult> {
    return this.exclusive(model, async () => {
      const started = Date.now();
      const res = await (this.deps.fetch ?? fetch)(new URL("/v1/chat/completions", model.url), {
        method: "POST", headers: { "content-type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
        body: JSON.stringify({ model: model.name, messages, temperature: 0.2, stream: false, ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}), ...(opts.json ? { response_format: { type: "json_object" } } : {}) }),
      }).catch((err: Error) => { throw new Refused(`${model.name} at ${new URL(model.url).host} did not answer: ${err.message}`, 503); });
      if (!res.ok) throw new Refused(`${model.name} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`, 503);
      const body = await res.json() as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
      const text = body.choices?.[0]?.message?.content ?? "";
      // Reasoning models wrap their thinking in <think>; only the answer is kept.
      return { text: text.replace(/<think>[\s\S]*?<\/think>/g, "").trim(), inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null, model: body.model ?? model.name, ms: Date.now() - started };
    });
  }

  /** For the Models page: what each endpoint serves, what is loaded, and how full this machine's GPU is. */
  async status(): Promise<LocalModelStatus[]> {
    const f = this.deps.fetch ?? fetch;
    const get = (m: LocalModel, path: string) => f(new URL(path, m.url), { signal: AbortSignal.timeout(4000), redirect: "error" }).then(async (r) => r.ok ? r.json() as Promise<Record<string, unknown>> : null, () => null);
    const gpus = await this.deps.run("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 5000 }).then((r) => parseGpus(r.stdout), () => []);
    return Promise.all(this.list().map(async (m): Promise<LocalModelStatus> => {
      const local = ["127.0.0.1", "localhost"].includes(new URL(m.url).hostname);
      const q = this.queue(m.url);
      const gpu = local && gpus[0] ? { name: gpus[0].name, totalMb: gpus[0].memoryTotalMiB ?? 0, usedMb: gpus[0].memoryUsedMiB ?? 0 } : null;
      const base = { name: m.name, provider: m.provider, url: m.url, local, gpu, waiting: q.waiting, running: q.running };
      if (m.provider === "ollama") {
        const [tags, ps] = await Promise.all([get(m, "/api/tags"), get(m, "/api/ps")]);
        if (!tags) return { ...base, state: "down", loaded: [], memory: null, detail: "Ollama did not answer." };
        const has = ((tags.models ?? []) as { name: string }[]).some((x) => x.name === m.name || x.name === `${m.name}:latest`);
        const loaded = ((ps?.models ?? []) as { name: string; size_vram?: number }[]);
        const vram = loaded.reduce((n, x) => n + (x.size_vram ?? 0), 0);
        return { ...base, state: loaded.some((x) => x.name === m.name || x.name === `${m.name}:latest`) ? "serving" : "idle", loaded: loaded.map((x) => x.name), memory: vram || null,
          detail: has ? null : `${m.name} is not pulled. Run: ollama pull ${m.name}` };
      }
      const health = await f(new URL("/health", m.url), { signal: AbortSignal.timeout(4000), redirect: "error" }).then((r) => r.ok, () => false);
      if (!health) return { ...base, state: "down", loaded: [], memory: null, detail: "The server did not answer." };
      const models = await get(m, "/v1/models");
      return { ...base, state: q.running ? "serving" : "idle", loaded: ((models?.data ?? []) as { id: string }[]).map((x) => x.id), memory: null, detail: null };
    }));
  }
}
