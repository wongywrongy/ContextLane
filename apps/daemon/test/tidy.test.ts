import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeMap } from "@contextlanes/protocol";
import { Config, LocalModels, type Runner } from "@contextlanes/daemon";
import { Tidy } from "../src/tidy.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const mod = (id: string, layer: string) => ({ id, layer, files: 3, lines: 30, tests: 0, tech: "TypeScript" });
const map = {
  syncedAt: "x", files: 9, layers: [{ name: "Logic", tech: "TypeScript" }, { name: "Data", tech: "Python" }], pairs: [], coveredBy: {}, paths: [], rules: { source: "inferred", roots: [] }, links: [],
  modules: [mod("apps/console/hooks", "Logic"), mod("apps/console/store", "Data"), mod("apps/api/db", "Data")],
} as CodeMap;

async function fixture(answer: string) {
  const root = await mkdtemp(join(tmpdir(), "cl-tidy-")); roots.push(root);
  const config = Config.parse({ paths: { data: root }, localModels: [{ name: "qwen3", provider: "ollama", url: "http://127.0.0.1:11434", roles: ["tidy"] }] });
  const fetch = (async (_u: string, init?: RequestInit) => init?.body ? Response.json({ model: "qwen3", choices: [{ message: { content: answer } }] }) : Response.json({ models: [] })) as unknown as typeof globalThis.fetch;
  const run: Runner = async () => ({ stdout: "" });
  return new Tidy({ config, models: new LocalModels({ config, run, fetch }), raw: async () => map, changed: () => {} });
}

describe("tidy", () => {
  it("proposes areas and layers, changes nothing until approved, then lays them over the map", async () => {
    const tidy = await fixture(JSON.stringify({ areas: [{ name: "Console app", modules: ["apps/console/hooks", "apps/console/store", "invented/module"] }, { name: "API", modules: ["apps/api/db"] }], layers: { "apps/console/store": "Logic", "apps/api/db": "Data", "apps/console/hooks": "Nonsense" }, notes: ["store is client state, not storage"] }));
    expect((await tidy.view("shop")).proposal).toBeNull();
    const view = await tidy.propose("shop");
    expect(view.proposal!.areaNames).toEqual(["Console app", "API"]);
    expect(view.proposal!.layers).toEqual({ "apps/console/store": "Logic" });
    expect(view.proposal!.changes.map((c) => [c.module, c.to.area, c.to.layer])).toEqual([["apps/console/hooks", "Console app", "Logic"], ["apps/console/store", "Console app", "Logic"], ["apps/api/db", "API", "Data"]]);
    expect(Tidy.apply(map, (await tidy.saved("shop")).approved)).toBe(map);
    await tidy.approve("shop");
    const tidied = Tidy.apply(map, (await tidy.saved("shop")).approved);
    expect(tidied.modules.find((m) => m.id === "apps/console/store")!.layer).toBe("Logic");
    expect(tidied.areas).toEqual({ "apps/console/hooks": "Console app", "apps/console/store": "Console app", "apps/api/db": "API" });
    expect((await tidy.view("shop")).approved).toMatchObject({ areas: 2, model: "qwen3" });
    await tidy.reset("shop");
    expect((await tidy.saved("shop")).approved).toBeNull();
  });

  it("refuses output that is not the grouping it asked for", async () => {
    const tidy = await fixture("Sure! Here are some areas.");
    await expect(tidy.propose("shop")).rejects.toThrow(/did not return a usable grouping/);
  });
});
