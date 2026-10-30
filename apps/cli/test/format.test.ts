import { describe, expect, it } from "vitest";
import type { Lane } from "@contextlanes/protocol";
import { formatInbox, formatLanes } from "@contextlanes/cli";

const lane = (n: string, state: Lane["state"], task: string): Lane => ({
  id: `shuttleworks/${n}`, project: "shuttleworks", goal: null, task, agent: "claude-code", model: null, mode: "edits",
  branch: `lane/${n}`, worktree: `/lanes/${n}`, terminal: `cl-shuttleworks-${n}`, state, colour: "lc1", createdAt: "2026-10-29T13:00:00Z",
});

describe("cli output", () => {
  it("prints lanes with a glyph and a word for each state", () => {
    const out = formatLanes([lane("01", "needs_you", "Billing phase 0"), lane("02", "working", "Solver tests")]);
    expect(out.split("\n")[0]).toMatch(/^LANE\s+PROJECT\s+STATE\s+AGENT\s+TASK$/);
    expect(out).toContain("◆ needs you");
    expect(out).toContain("● working");
  });
  it("says so when nothing is waiting", () => {
    expect(formatInbox([])).toBe("Nothing is waiting on you.");
  });
});

import { formatArch, formatMermaid } from "../src/format.js";
import type { ProjectMap } from "@contextlanes/protocol";
describe("contextlanes arch", () => {
  const view: ProjectMap = { error: null, lanes: [{ lane: "shop/01", modules: { "models/t.py": ["models/t.py"], "billing/fees.py": ["billing/fees.py"] }, created: ["billing/fees.py"] }, { lane: "shop/02", modules: { "models/t.py": ["models/t.py"] }, created: [] }],
    map: { syncedAt: "2026-10-30T10:00:00.000Z", files: 3, layers: [{ name: "API", tech: "Python" }, { name: "Data", tech: null }],
      modules: [{ id: "api/routes", layer: "API", files: 2, lines: 10, tests: 0 }, { id: "models/t.py", layer: "Data", files: 1, lines: 4, tests: 1 }],
      links: [{ source: "api/routes", target: "models/t.py", count: 3, kinds: ["imports"] }], pairs: [], coveredBy: {}, paths: [{ name: "POST /api/t", modules: ["api/routes", "models/t.py"] }], rules: { source: "inferred", roots: [] } } };
  it("prints layers, lanes, collisions, new modules and main paths", () => {
    const text = formatArch(view);
    expect(text).toContain("API (Python)\n    api/routes  2 files\n      uses models/t.py");
    expect(text).toContain("  * models/t.py  1 file  [01 02]");
    expect(text).toContain("NEW IN LANES\n    billing/fees.py [01]");
    expect(text).toContain("POST /api/t: api/routes → models/t.py");
  });
  it("prints Mermaid with lane styles", () => {
    const m = formatMermaid(view);
    expect(m.split("\n")[0]).toBe("flowchart LR");
    expect(m).toContain("m_api_routes --> m_models_t_py");
    expect(m).toContain("class m_models_t_py two");
  });
});
