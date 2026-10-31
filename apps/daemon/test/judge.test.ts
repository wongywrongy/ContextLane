import { describe, expect, it } from "vitest";
import type { Checkpoint } from "@contextlanes/protocol";
import { Config, EventBus, LocalModels, Store, type Runner } from "@contextlanes/daemon";
import { Judge, diffForJudge, settle } from "../src/judge.js";

const checkpoint = (over: Partial<Checkpoint> = {}): Checkpoint => ({ id: "c1", lane: "shop/01", base: "a", head: "b", summary: "Due dates in the club's timezone", checks: [{ name: "tests", passed: true, ms: 10, detail: "", counts: null }],
  screenshots: [], files: [{ path: "billing/dates.py", added: 31, removed: 9 }, { path: "pnpm-lock.yaml", added: 900, removed: 10 }], plan: [{ text: "Due dates in the club's timezone", status: "completed" }],
  unplanned: [], process: [], signal: "strong", decision: null, prUrl: null, createdAt: new Date().toISOString(), ...over });
const DIFF = "diff --git a/billing/dates.py b/billing/dates.py\n@@ -1 +1 @@\n-return fee.issued_at + delta\n+return end_of_day(local + delta)\n"
  + "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n@@ lots @@\n" + "x".repeat(50_000) + "\n";

describe("review judge", () => {
  it("reads the real change: lockfiles and generated files left out, biggest files first, within budget", () => {
    const { text, skipped } = diffForJudge(DIFF);
    expect(text).toContain("billing/dates.py");
    expect(text).not.toContain("pnpm-lock");
    expect(skipped).toEqual(["pnpm-lock.yaml"]);
    const many = Array.from({ length: 10 }, (_, i) => `diff --git a/src/f${i}.ts b/src/f${i}.ts\n${"+line\n".repeat(1500)}`).join("");
    const big = diffForJudge(many);
    expect(big.text.length).toBeLessThanOrEqual(18_000);
    expect(big.skipped.length).toBeGreaterThan(0);
  });

  it("shows only findings on changed files, and lowers a 'merge' when the evidence disagrees", () => {
    const raw = { verdict: "Merge", headline: "Moves due dates to the club timezone.\nMore prose.", findings: [
      { severity: "nit", file: "billing/dates.py", line: 4, text: "Unused import." },
      { severity: "blocker", file: "b/billing/dates.py:12", line: "12", text: "end_of_day is called with a naive datetime." },
      { severity: "should fix", file: "billing/invented.py", line: 1, text: "Not in the change." },
    ] };
    expect(settle(raw, checkpoint())).toEqual({ verdict: "fix first", headline: "Moves due dates to the club timezone.", findings: [
      { severity: "blocker", file: "billing/dates.py", line: 12, text: "end_of_day is called with a naive datetime." },
      { severity: "nit", file: "billing/dates.py", line: 4, text: "Unused import." },
    ] });
    const failing = checkpoint({ checks: [{ name: "tests", passed: false, ms: 1, detail: "1 failed", counts: null }] });
    expect(settle({ verdict: "merge", headline: "Fine.", findings: [] }, failing)!.verdict).toBe("fix first");
    expect(settle({ verdict: "do not merge", headline: "Breaks billing.", findings: [] }, checkpoint())!.verdict).toBe("do not merge");
    expect(settle({ nonsense: true }, checkpoint())).toBeNull();
  });

  it("judges each new checkpoint with the local model and records it as an event; says when there is no model", async () => {
    const store = Store.open(":memory:"); const bus = new EventBus();
    store.addProject({ id: "shop", name: "Shop", path: "/shop" });
    store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Due dates", agent: "codex", model: null, mode: "ask", branch: "b", worktree: "/w", terminal: "t", hostUnit: null, base: "main", state: "in_review", colour: "lc1" });
    store.insertCheckpoint(checkpoint());
    const sent: string[] = [];
    const fetch = (async (url: URL, init?: RequestInit) => {
      if (String(url).endsWith("/api/tags")) return Response.json({ models: [] });
      sent.push(String(init?.body));
      return Response.json({ model: "gpt-oss:20b", choices: [{ message: { content: JSON.stringify({ verdict: "merge", headline: "Due dates now follow the club timezone.", findings: [] }) } }] });
    }) as unknown as typeof globalThis.fetch;
    const run: Runner = async () => ({ stdout: "" });
    const models = new LocalModels({ config: Config.parse({ localModels: [{ name: "gpt-oss:20b", provider: "ollama", url: "http://127.0.0.1:11434", roles: ["insights"] }] }), run, fetch });
    const judge = new Judge({ store, bus, models, diff: async () => DIFF });
    const result = await judge.judge("c1");
    expect(result).toMatchObject({ state: "done", verdict: "merge", headline: "Due dates now follow the club timezone.", model: "gpt-oss:20b", skipped: ["pnpm-lock.yaml"] });
    expect(store.checkpoint("c1")!.judge).toMatchObject({ state: "done", verdict: "merge" });
    expect(store.events("shop/01").filter((e) => e.type === "checkpoint.judged").map((e) => e.payload)).toEqual([
      { checkpointId: "c1", state: "running", verdict: null }, { checkpointId: "c1", state: "done", verdict: "merge" }]);
    expect(sent[0]).toContain("billing/dates.py");
    expect(models.history().at(-1)).toMatchObject({ role: "judge", ok: true });
    // No endpoint for judging or insights: it says so instead of guessing.
    const none = new Judge({ store, bus, models: new LocalModels({ config: Config.parse({}), run, fetch }), diff: async () => DIFF });
    expect(await none.judge("c1")).toMatchObject({ state: "off" });
    expect(() => none.again("missing")).toThrow(/no such checkpoint/);
  });
});
