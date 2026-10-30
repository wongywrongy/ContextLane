import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeMap } from "@contextlanes/protocol";
import { Briefs, Config, LocalModels, Store, type CodeMaps, type Runner } from "@contextlanes/daemon";
import { Ask } from "../src/ask.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

describe("⌘K Ask", () => {
  it("answers from notes, the code map and lanes, and keeps only citations to sources it was given", async () => {
    const root = await mkdtemp(join(tmpdir(), "cl-ask-")); roots.push(root);
    const store = Store.open(":memory:"); store.addProject({ id: "shop", name: "Shop", path: "/shop" });
    store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Billing phase 0", agent: "codex", model: null, mode: "ask", branch: "b", worktree: "/w", terminal: "t", hostUnit: null, base: "main", state: "working", colour: "lc1" });
    let seen = "";
    const fetch = (async (_u: string, init?: RequestInit) => { seen = String(init?.body ?? ""); return Response.json({ model: "qwen3-coder", choices: [{ message: { content: "Fees are computed in billing/fees [module:billing/fees]. Lane 01 is changing it [lane:shop/01]. It uses UTC [notes] [made:up]." } }] }); }) as unknown as typeof globalThis.fetch;
    const config = Config.parse({ paths: { data: join(root, "data") }, localModels: [{ name: "qwen3-coder", provider: "ollama", url: "http://127.0.0.1:11434" }] });
    const run: Runner = async () => ({ stdout: "" });
    const models = new LocalModels({ config, run, fetch });
    const map = { syncedAt: "x", files: 1, layers: [{ name: "Logic", tech: null }], modules: [{ id: "billing/fees", layer: "Logic", files: 2, lines: 10, tests: 0 }], links: [], pairs: [], coveredBy: {}, paths: [], rules: { source: "inferred", roots: [] } } as CodeMap;
    const codemaps = { map: async () => ({ map, error: null }) } as unknown as CodeMaps;
    const briefs = new Briefs({ config, store, codemaps, models });
    await briefs.saveNotes("shop", "Match times are UTC.");
    const a = await new Ask({ store, codemaps, briefs, models }).ask("shop", "Where are fees computed?");
    expect(seen).toContain("Match times are UTC.");
    expect(seen).toContain("billing/fees [Logic, 2 files]");
    expect(a.answer).not.toContain("made:up");
    expect(a.sources.map((s) => s.id)).toEqual(["lane:shop/01", "notes"]);
  });
});
