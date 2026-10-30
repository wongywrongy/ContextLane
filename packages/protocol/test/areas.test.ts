import { describe, expect, it } from "vitest";
import { areaOf, codeAreas, type CodeMap } from "../src/index.js";

const mod = (id: string, layer: string, files = 1) => ({ id, layer, files, lines: 0, tests: 0 });
const map = {
  syncedAt: "x", files: 0, layers: [], pairs: [], coveredBy: {}, paths: [], rules: { source: "inferred", roots: [] },
  modules: [mod("apps/console/hooks", "Logic", 38), mod("apps/console/store", "Data", 4), mod("apps/api/db", "Data", 32), mod("apps/api/billing", "API", 9), mod("packages/brand", "Logic"), mod("solver/model.py", "Logic")],
  links: [{ source: "apps/console/hooks", target: "apps/api/billing", count: 3, kinds: [] }, { source: "apps/console/store", target: "apps/api/db", count: 2, kinds: [] }, { source: "apps/console/hooks", target: "apps/console/store", count: 9, kinds: [] }],
} as CodeMap;

describe("areas", () => {
  it("groups modules by top folder, or by the approved tidy's names", () => {
    expect(["apps/console/hooks", "packages/brand", "solver/model.py"].map((m) => areaOf(m, map))).toEqual(["apps/console", "packages/brand", "solver"]);
    expect(areaOf("apps/console/store", { areas: { "apps/console/store": "State" } })).toBe("State");
  });
  it("sums links between areas and leaves out links inside one", () => {
    const areas = codeAreas(map);
    expect(areas.map((a) => a.name)).toEqual(["apps/console", "apps/api", "packages/brand", "solver"]);
    expect(areas[0]).toMatchObject({ modules: ["apps/console/hooks", "apps/console/store"], files: 42, layers: ["Logic", "Data"], uses: [{ area: "apps/api", count: 5 }], usedBy: [] });
    expect(areas[1]!.usedBy).toEqual([{ area: "apps/console", count: 5 }]);
  });
});
