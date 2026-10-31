import { describe, expect, it } from "vitest";
import { LocalModel } from "@contextlanes/protocol";
import { Config, LocalModels, type Runner } from "@contextlanes/daemon";
import { jsonAnswer } from "../src/localmodels.js";

const ollama = { name: "qwen3-coder:30b", provider: "ollama" as const, url: "http://127.0.0.1:11434" };
const config = (models = [ollama]) => Config.parse({ localModels: models });
const run: Runner = async (cmd) => cmd === "nvidia-smi" ? { stdout: "NVIDIA RTX PRO 4000 Blackwell, 80, 19560, 24467\n" } : { stdout: "" };

describe("local models", () => {
  it("accepts this machine and the tailnet, not the internet", () => {
    for (const url of ["http://127.0.0.1:11434", "http://oracle.tail1234.ts.net:8080", "http://100.94.247.118:8080"]) expect(LocalModel.safeParse({ ...ollama, url }).success).toBe(true);
    for (const url of ["http://example.com:11434", "http://192.168.1.5:11434", "http://100.200.1.1:8080", "file:///etc/passwd"]) expect(LocalModel.safeParse({ ...ollama, url }).success).toBe(false);
  });

  it("gives a reasoning model room to think, retries without JSON mode, and explains an empty answer", async () => {
    const sent: Record<string, unknown>[] = [];
    let reply: () => Response = () => Response.json({ choices: [{ message: { content: "ok" } }] });
    const fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      sent.push(body);
      if (body.response_format) return new Response("response_format is not supported", { status: 400 });
      return reply();
    }) as unknown as typeof globalThis.fetch;
    const oss = { ...ollama, name: "gpt-oss:20b" };
    const models = new LocalModels({ config: config([oss]), run, fetch });
    expect((await models.chat(oss, [{ role: "user", content: "hi" }], { json: true, maxTokens: 1500 })).text).toBe("ok");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ max_tokens: 1500 + 4096, reasoning_effort: "low", response_format: { type: "json_object" } });
    expect(sent[1]).not.toHaveProperty("response_format");
    reply = () => Response.json({ choices: [{ message: { content: "", reasoning: "thinking…" }, finish_reason: "length" }] });
    await expect(models.chat(oss, [{ role: "user", content: "hi" }])).rejects.toThrow(/whole token budget thinking/);
    expect(jsonAnswer('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(jsonAnswer('Sure. {"a":{"b":2}} Hope that helps.')).toEqual({ a: { b: 2 } });
    expect(jsonAnswer("no json")).toBeNull();
  });

  it("moves a job to the next endpoint with the same role when the first fails", async () => {
    const down = { ...ollama, url: "http://100.67.8.121:11434", roles: ["insights" as const] };
    const up = { ...ollama, url: "http://127.0.0.1:11434", roles: ["insights" as const] };
    const fetch = (async (url: string) => {
      if (String(url).startsWith(down.url)) return new Response("model crashed", { status: 500 });
      return String(url).endsWith("/api/tags") ? Response.json({ models: [] }) : Response.json({ model: "served", choices: [{ message: { content: "answer" } }] });
    }) as unknown as typeof globalThis.fetch;
    const models = new LocalModels({ config: config([down, up]), run, fetch });
    expect(await models.chatAny("insights", down, [{ role: "user", content: "hi" }])).toMatchObject({ text: "answer", model: "served" });
  });

  it("drops a job that waited too long, skips it later, and lets a running job finish", async () => {
    const models = new LocalModels({ config: config(), run });
    let release!: () => void;
    const ran: string[] = [];
    const first = models.exclusive(ollama, async () => { ran.push("first"); await new Promise<void>((r) => { release = r; }); return "first"; }, 20);
    const second = models.exclusive(ollama, async () => { ran.push("second"); return "second"; }, 20);
    await expect(second).rejects.toThrow(/busy for/);
    release();
    await expect(first).resolves.toBe("first");
    const third = await models.exclusive(ollama, async () => { ran.push("third"); return "third"; });
    expect(third).toBe("third");
    expect(ran).toEqual(["first", "third"]);
  });

  it("refuses at once when too many jobs are already waiting", async () => {
    const models = new LocalModels({ config: config(), run });
    let release!: () => void;
    const block = models.exclusive(ollama, () => new Promise<void>((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 0));
    const queued = Array.from({ length: 20 }, () => models.exclusive(ollama, async () => {}));
    await expect(models.exclusive(ollama, async () => {})).rejects.toThrow(/20 jobs waiting/);
    release(); await block; await Promise.all(queued);
  });

  it("runs one job at a time per GPU and keeps only the answer", async () => {
    let active = 0, peak = 0;
    const fetch = (async (_url: string, init: RequestInit) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      const body = JSON.parse(String(init.body)) as { model: string; messages: { content: string }[] };
      return Response.json({ model: body.model, choices: [{ message: { content: `<think>hmm</think>\nAnswer to ${body.messages.at(-1)!.content}` } }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
    }) as unknown as typeof globalThis.fetch;
    const models = new LocalModels({ config: config(), run, fetch });
    const [a, b] = await Promise.all([models.chat(ollama, [{ role: "user", content: "one" }]), models.chat(ollama, [{ role: "user", content: "two" }])]);
    expect(peak).toBe(1);
    expect(a).toMatchObject({ text: "Answer to one", inputTokens: 12, outputTokens: 5 });
    expect(b.text).toBe("Answer to two");
  });

  it("says what is loaded, what is missing, and how full this machine's GPU is", async () => {
    const llama = { name: "gpt-oss-20b", provider: "llama.cpp" as const, url: "http://100.94.247.118:8080" };
    const fetch = (async (url: URL) => {
      if (url.port === "11434") return url.pathname === "/api/tags" ? Response.json({ models: [{ name: "llama3:8b" }] }) : Response.json({ models: [{ name: "llama3:8b", size_vram: 6e9 }] });
      return url.pathname === "/health" ? Response.json({ status: "ok" }) : Response.json({ data: [{ id: "gpt-oss-20b" }] });
    }) as unknown as typeof globalThis.fetch;
    const [o, l] = await new LocalModels({ config: config([ollama, llama]), run, fetch }).status();
    expect(o).toMatchObject({ state: "idle", loaded: ["llama3:8b"], gpu: { name: "NVIDIA RTX PRO 4000 Blackwell", usedMb: 19560, totalMb: 24467 }, detail: "qwen3-coder:30b is not pulled. Run: ollama pull qwen3-coder:30b" });
    expect(l).toMatchObject({ state: "idle", loaded: ["gpt-oss-20b"], gpu: null, local: false });
    const down = await new LocalModels({ config: config(), run, fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof globalThis.fetch }).status();
    expect(down[0]).toMatchObject({ state: "down" });
  });

  it("sends each job to an endpoint with its role, the free one first, skipping one that is down", async () => {
    const neo = { ...ollama, label: "neo", roles: ["helper", "briefs"] as const };
    const cayde = { ...ollama, url: "http://cayde.tail1234.ts.net:11434", label: "cayde", roles: ["helper"] as const };
    const small = { name: "qwen3:4b", provider: "ollama" as const, url: "http://127.0.0.1:11434", roles: ["insights"] as const };
    let caydeUp = true;
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.hostname.startsWith("cayde") && !caydeUp) throw new Error("down");
      if (!init?.body) return Response.json({ models: [] });
      await new Promise((r) => setTimeout(r, 30));
      return Response.json({ model: "m", choices: [{ message: { content: "ok" } }] });
    }) as unknown as typeof globalThis.fetch;
    const models = new LocalModels({ config: config([neo, cayde, small] as never), run, fetch });
    expect(models.candidates("helper").map((m) => m.label)).toEqual(["neo", "cayde"]);
    expect(models.candidates("insights").map((m) => m.name)).toEqual(["qwen3:4b"]);
    expect(models.pick("ask")).toBeNull();
    // neo is busy, so the next helper job goes to cayde.
    const busy = models.chat(neo, [{ role: "user", content: "long" }]);
    expect((await models.forJob("helper"))?.label).toBe("cayde");
    await busy;
    const down = new LocalModels({ config: config([cayde, neo] as never), run, fetch });
    caydeUp = false;
    expect((await down.forJob("helper"))?.label).toBe("neo");
  });
});
