import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assign, globToRegExp, sourceRoots, type CodeMap } from "@contextlanes/protocol";
import { CodeMaps, Config, Store, runCommand, type Runner } from "@contextlanes/daemon";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

describe("module rules", () => {
  it("names modules after packages in a monorepo, and two levels under src otherwise", () => {
    const mono: CodeMap["rules"] = { source: "inferred", roots: sourceRoots(["packages/db/src/a.ts", "apps/api/src/b.ts", "README.md"]) };
    expect(mono.roots.sort()).toEqual(["apps/*", "packages/*"]);
    expect(assign("apps/api/src/routes/fees.ts", mono)).toEqual({ module: "apps/api", layer: "API" });
    expect(assign("apps/api/src/routes/fees.test.ts", mono)).toBeNull();
    expect(assign("tools/x.ts", mono)).toBeNull();
    const app: CodeMap["rules"] = { source: "inferred", roots: [] };
    expect(assign("models/tournament.py", app)).toEqual({ module: "models/tournament.py", layer: "Data" });
    expect(assign("pages/schedule/index.tsx", app)).toEqual({ module: "pages/schedule", layer: "Web" });
    expect(assign("solver/constraints/time.py", app)).toEqual({ module: "solver/constraints", layer: "Logic" });
    expect(assign("tests/solver/test_model.py", app)).toBeNull();
    expect(assign("apps/daemon/src/db/store.ts", { ...mono, split: ["apps/daemon"] })).toEqual({ module: "apps/daemon/db", layer: "Data" });
  });
  it("uses the recipe's layers when it has them", () => {
    expect(globToRegExp("src/web/**").test("src/web/pages/a.tsx")).toBe(true);
    expect(globToRegExp("src/*/api").test("src/x/api/y.ts")).toBe(true);
    const rules: CodeMap["rules"] = { source: "recipe", roots: [], layers: [{ name: "Front", paths: ["web/**"] }, { name: "Back", paths: ["server"] }] };
    expect(assign("web/pages/home.tsx", rules)).toEqual({ module: "web/pages", layer: "Front" });
    expect(assign("server/db.py", rules)).toEqual({ module: "server/db.py", layer: "Back" });
    expect(assign("scripts/x.py", rules)).toBeNull();
  });
});

const hasCodeGraph = (() => { try { return spawnSync(process.execPath, ["-e", "require('@colbymchenry/codegraph')"], { cwd: join(process.cwd(), "apps/daemon") }).status === 0; } catch { return false; } })();

describe.skipIf(!hasCodeGraph)("code map with CodeGraph", () => {
  it("maps a Python app's layers, links, tests and an overlay of a lane's changes", { timeout: 120_000 }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cl-map-"))); roots.push(root);
    const repo = join(root, "shop");
    const files: Record<string, string> = {
      "models/tournament.py": "class Tournament:\n    def to_solver_input(self):\n        return {}\n",
      "solver/model.py": "from models.tournament import Tournament\n\ndef solve(t: Tournament):\n    return t.to_solver_input()\n",
      "api/routes.py": "from solver.model import solve\nfrom models.tournament import Tournament\n\ndef schedule():\n    return solve(Tournament())\n",
      "tests/test_solver.py": "from solver.model import solve\n\ndef test_solve():\n    assert solve is not None\n",
      ".contextlanes.json": "{}",
    };
    for (const [f, text] of Object.entries(files)) { await mkdir(dirname(join(repo, f)), { recursive: true }); await writeFile(join(repo, f), text); }
    const git = (cwd: string, ...a: string[]) => runCommand("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...a], { cwd });
    await git(repo, "init", "-q"); await git(repo, "add", "-A"); await git(repo, "commit", "-qm", "one");
    const worktree = join(root, "lane"); await git(repo, "worktree", "add", "-q", "-b", "lane/01", worktree, "main");
    await writeFile(join(worktree, "models/tournament.py"), `${files["models/tournament.py"]}\n# invoice link\n`);
    await mkdir(join(worktree, "billing")); await writeFile(join(worktree, "billing/fees.py"), "def fee():\n    return 1\n");

    const store = Store.open(":memory:");
    store.addProject({ id: "shop", name: "Shop", path: repo });
    store.insertLane({ id: "shop/01", n: 1, project: "shop", goal: null, task: "Invoices", agent: "codex", model: null, mode: "ask", branch: "lane/01", worktree, terminal: "t", hostUnit: null, base: "main", state: "working", colour: "lc1" });
    // The worker runs without the sandbox here; the daemon wraps it in bubblewrap.
    const run: Runner = async (cmd, args, opts) => cmd === "bwrap" ? runCommand(args[args.indexOf("--") + 1]!, args.slice(args.indexOf("--") + 2), opts) : runCommand(cmd, args, opts);
    const maps = new CodeMaps({ run, store, config: Config.parse({ paths: { data: join(root, "data"), lanes: root } }), worker: join(process.cwd(), "apps/daemon/dist/codemap-worker.js") });
    const { map, error, lanes } = await maps.project("shop");
    expect(error).toBeNull();
    expect(map!.modules.map((m) => [m.id, m.layer])).toEqual([["api/routes.py", "API"], ["models/tournament.py", "Data"], ["solver/model.py", "Logic"]]);
    expect(map!.links).toEqual(expect.arrayContaining([expect.objectContaining({ source: "solver/model.py", target: "models/tournament.py" }), expect.objectContaining({ source: "api/routes.py", target: "solver/model.py" })]));
    expect(map!.coveredBy["solver/model.py"]).toEqual([{ module: "tests", files: 1 }]);
    expect(map!.layers.map((l) => l.name)).toEqual(["API", "Logic", "Data"]);
    expect(lanes).toEqual([{ lane: "shop/01", modules: { "models/tournament.py": ["models/tournament.py"], "billing/fees.py": ["billing/fees.py"] }, created: ["billing/fees.py"] }]);
    expect(await readFile(join(repo, ".git/info/exclude"), "utf8")).toContain(".codegraph/");
    expect((await runCommand("git", ["status", "--porcelain"], { cwd: repo })).stdout).toBe("");
  });
});
