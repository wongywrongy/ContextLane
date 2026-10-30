import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeMap } from "@contextlanes/protocol";
import { Config, LocalModels, Store, type CodeMaps, type Runner } from "@contextlanes/daemon";
import { Briefs } from "../src/briefs.js";
import { hostCommand } from "../src/lanes/manager.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

async function fixture(withModel = true) {
  const root = await mkdtemp(join(tmpdir(), "cl-brief-")); roots.push(root);
  const repo = join(root, "shop"); await mkdir(join(repo, "models"), { recursive: true });
  await writeFile(join(repo, "models/tournament.py"), "class Tournament:\n    # Match times are UTC.\n    def to_solver_input(self):\n        return {}\n" + "# padding\n".repeat(400));
  const store = Store.open(":memory:"); store.addProject({ id: "shop", name: "Shop", path: repo });
  let hash = "h1";
  const map = () => ({ syncedAt: "x", files: 1, layers: [{ name: "Data", tech: "Python" }], links: [{ source: "solver/model.py", target: "models/tournament.py", count: 2, kinds: ["calls"] }],
    pairs: [{ source: "solver/model.py", target: "models/tournament.py", from: "solve", to: "to_solver_input", count: 2 }], coveredBy: {}, paths: [], rules: { source: "inferred", roots: [] },
    modules: [{ id: "models/tournament.py", layer: "Data", files: 1, lines: 404, tests: 0, hash, symbols: [{ name: "Tournament", kind: "class", file: "models/tournament.py", signature: null }], paths: ["models/tournament.py"] }] } as CodeMap);
  const codemaps = { map: async () => ({ map: map(), error: null }) } as unknown as CodeMaps;
  const prompts: string[] = [];
  const fetch = (async (_u: string, init: RequestInit) => { prompts.push(String(init.body)); return Response.json({ model: "qwen3-coder", choices: [{ message: { content: "Tournament records. Times are UTC. The solver reads them through to_solver_input()." } }] }); }) as unknown as typeof globalThis.fetch;
  const config = Config.parse({ paths: { data: join(root, "data") }, localModels: withModel ? [{ name: "qwen3-coder", provider: "ollama", url: "http://127.0.0.1:11434" }] : [] });
  const run: Runner = async () => ({ stdout: "" });
  return { briefs: new Briefs({ config, store, codemaps, models: new LocalModels({ config, run, fetch }) }), prompts, change: () => { hash = "h2"; }, config };
}

describe("module briefs", () => {
  it("writes a brief from CodeGraph's facts and the files, caches it, and marks it stale when the files change", async () => {
    const f = await fixture();
    const before = await f.briefs.get("shop", { path: "models/tournament.py" });
    expect(before).toMatchObject({ module: "models/tournament.py", text: null, canWrite: true });
    expect(before.facts).toContain("Used by: solver/model.py (to_solver_input)");
    expect(before.filesTokens).toBeGreaterThan(900);
    const written = await f.briefs.write("shop", { module: "models/tournament.py" });
    expect(written).toMatchObject({ text: expect.stringContaining("UTC"), edited: false, stale: false, model: "qwen3-coder" });
    expect(written.tokens!).toBeLessThan(written.filesTokens / 10);
    expect(f.prompts[0]).toContain("Match times are UTC");
    f.change();
    expect((await f.briefs.get("shop", { module: "models/tournament.py" })).stale).toBe(true);
  });

  it("keeps the owner's edit, and gives agents the brief with the facts", async () => {
    const f = await fixture();
    await f.briefs.edit("shop", "models/tournament.py", "Owner: never store local times.");
    const text = await f.briefs.forAgent("shop", { path: "models/tournament.py" });
    expect(text).toContain("Owner: never store local times.");
    expect(text).toContain("Exports: Tournament [class, models/tournament.py]");
    expect(f.prompts).toEqual([]);
  });

  it("answers with facts alone when no local model is set up", async () => {
    const f = await fixture(false);
    const text = await f.briefs.forAgent("shop", { module: "models/tournament.py" });
    expect(text).toMatch(/^No brief: no local model is set up\.\n\nModule models\/tournament.py/);
    await expect(f.briefs.write("shop", { module: "models/tournament.py" })).rejects.toThrow(/Add a local model/);
    await expect(f.briefs.get("shop", { module: "nope" })).rejects.toThrow(/No module nope/);
  });

  it("starts every lane with the project notes", async () => {
    const args = hostCommand({ id: "shop/01", worktree: "/w", task: "Add invoices", agent: "codex", model: null, mode: "ask" } as Parameters<typeof hostCommand>[0], Config.parse({}), undefined, undefined, "Match times are UTC.");
    expect(args.find((a) => a.startsWith("--task="))).toBe("--task=Project notes from the owner. Keep to them unless the task says otherwise:\nMatch times are UTC.\n\n---\n\nAdd invoices");
  });
});
