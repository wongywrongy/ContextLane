import { describe, expect, it } from "vitest";
import { LocalModel } from "@contextlanes/protocol";
import { Config, LocalModels, type Runner } from "@contextlanes/daemon";

const ollama = { name: "qwen3-coder:30b", provider: "ollama" as const, url: "http://127.0.0.1:11434" };
const config = (models = [ollama]) => Config.parse({ localModels: models });
const run: Runner = async (cmd) => cmd === "nvidia-smi" ? { stdout: "NVIDIA RTX PRO 4000 Blackwell, 80, 19560, 24467\n" } : { stdout: "" };

describe("local models", () => {
  it("accepts this machine and the tailnet, not the internet", () => {
    for (const url of ["http://127.0.0.1:11434", "http://oracle.tail1234.ts.net:8080", "http://100.94.247.118:8080"]) expect(LocalModel.safeParse({ ...ollama, url }).success).toBe(true);
    for (const url of ["http://example.com:11434", "http://192.168.1.5:11434", "http://100.200.1.1:8080", "file:///etc/passwd"]) expect(LocalModel.safeParse({ ...ollama, url }).success).toBe(false);
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
});
