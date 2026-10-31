import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Briefs, Config, EventBus, Insights, LocalModels, Store, type CodeMaps, type Runner } from "@contextlanes/daemon";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

async function fixture(answer: unknown, withModel = true) {
  const root = await mkdtemp(join(tmpdir(), "cl-insights-")); roots.push(root);
  const store = Store.open(":memory:"); const bus = new EventBus();
  store.addProject({ id: "shop", name: "Shop", path: "/shop" });
  for (const n of [1, 2]) store.insertLane({ id: `shop/0${n}`, n, project: "shop", goal: null, task: `Task ${n}`, agent: "codex", model: null, mode: "ask", branch: `b${n}`, worktree: `/w${n}`, terminal: `t${n}`, hostUnit: null, base: "main", state: "working", colour: "lc1" });
  const ask = (lane: string, id: string) => store.appendEvent(lane, { type: "permission.requested", payload: { requestId: id, title: "Which fixture should the solver tests use?", kind: "question", options: [{ id: "0", label: "2025 seed", kind: "allow_once" }] } });
  ask("shop/02", "q1"); store.appendEvent("shop/02", { type: "permission.answered", payload: { requestId: "q1", optionId: "0", by: "web" } }); ask("shop/02", "q2");
  for (let i = 0; i < 5; i++) store.appendEvent("shop/01", { type: "tool.call", payload: { callId: `r${i}`, kind: "read", title: "Read", files: ["/w1/solver/model.py"] } });
  store.appendEvent("shop/01", { type: "usage.turn", payload: { turnId: "6e0c8a8e-8a1c-4a4b-9d7f-0f2b4a6b1c11", sessionId: "s", source: "acp", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 8500, cacheWriteTokens: 0 } });
  store.setLaneState("shop/01", "in_review"); store.setLaneState("shop/01", "merged");
  const fetch = (async () => Response.json({ model: "qwen3-coder", choices: [{ message: { content: JSON.stringify(answer) } }] })) as unknown as typeof globalThis.fetch;
  const config = Config.parse({ paths: { data: join(root, "data") }, localModels: withModel ? [{ name: "qwen3-coder", provider: "ollama", url: "http://127.0.0.1:11434" }] : [] });
  const run: Runner = async () => ({ stdout: "" });
  const models = new LocalModels({ config, run, fetch });
  const codemaps = { map: async () => ({ map: null, error: "none" }) } as unknown as CodeMaps;
  return new Insights({ config, store, bus, models, codemaps, briefs: new Briefs({ config, store, codemaps, models }) });
}

describe("insights", () => {
  it("computes the week's numbers itself", async () => {
    const i = await fixture({}, false);
    const v = await i.view("shop");
    expect(v.facts).toMatchObject({ merges: 1, cloudTokens: 10_000, localShare: 0 });
    expect(v.stats.map((s) => [s.id, s.value])).toEqual(expect.arrayContaining([["merges", "1"], ["cloud", "10k"], ["reads:solver/model.py", "5"], [expect.stringMatching(/^question:/), "2"]]));
    expect(v.today).toEqual([expect.objectContaining({ lane: "shop/01", tokens: 10_000, cacheShare: expect.closeTo(0.895, 2) })]);
    await expect(i.generate("shop")).rejects.toThrow(/Add a local model/);
  });

  it("keeps only sentences and suggestions whose numbers and evidence are real", async () => {
    const probe = await fixture({}, false);
    const qid = (await probe.view("shop")).stats.find((s) => s.id.startsWith("question:"))!.id;
    const i = await fixture({
      summary: [{ text: "Lane 02 asked the same fixture question 2 times.", cites: [qid] }, { text: "Tokens fell 40% this week.", cites: ["cloud"] }],
      suggestions: [
        { type: "process", title: "Answer the fixture question once, in project notes", body: "Lane 02 stopped 2 times to ask which fixture to use.", stat: qid, evidence: [qid], action: { kind: "add_note", text: "Solver tests use the 2025 seed fixture." } },
        { type: "tokens", title: "Read less", body: "Lanes read solver/model.py 99 times.", stat: "reads:solver/model.py", evidence: ["reads:solver/model.py"], action: { kind: "allow_helper", helper: "read" } },
        { type: "code", title: "Split billing", body: "It is busy.", stat: "module:billing", evidence: ["module:billing"], action: { kind: "start_lane", task: "Split billing" } },
      ],
    });
    const v = await i.generate("shop");
    expect(v.summary).toEqual([{ text: "Lane 02 asked the same fixture question 2 times.", cites: [qid] }]);
    expect(v.suggestions.map((s) => s.title)).toEqual(["Answer the fixture question once, in project notes"]);
    await i.dismiss("shop", v.suggestions[0]!.id);
    expect((await i.view("shop")).suggestions).toEqual([]);
  });

  it("shows why a run failed until one succeeds", async () => {
    const i = await fixture("I cannot help with that.");
    await expect(i.generate("shop")).rejects.toThrow(/did not return usable insights/);
    expect((await i.view("shop")).error).toMatchObject({ message: expect.stringMatching(/did not return usable insights/) });
  });
});
