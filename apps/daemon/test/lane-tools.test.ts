import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const built = existsSync(join(root, "apps/cli/dist/main.js")) && existsSync(join(root, "packages/toolbox/dist/main.js"));

/** What the tools volume gives lanes: the bundle must run alone, with no node_modules beside it (pnpm check builds first). */
describe.skipIf(!built)("the lane tools bundle", () => {
  it("builds single files that run from a folder with nothing else in it", async () => {
    const out = await mkdtemp(join(tmpdir(), "cl-lanetools-"));
    try {
      const made = spawnSync(process.execPath, [join(root, "scripts/lane-tools/bundle.mjs"), out], { encoding: "utf8" });
      expect(made.status, made.stderr).toBe(0);
      expect((await readdir(out)).sort()).toEqual(["cli-agent.mjs", "cli.mjs", "hook.mjs", "toolbox.mjs"]);
      const env = { PATH: "/usr/bin:/bin", CONTEXTLANES_URL: "http://127.0.0.1:1", CONTEXTLANES_LANE: "shop/01", CONTEXTLANES_LANE_TOKEN: "cl-lane-x" };
      const help = spawnSync(process.execPath, [join(out, "cli.mjs"), "help", "--json"], { encoding: "utf8", cwd: out, env });
      expect(help.status, help.stderr).toBe(0);
      expect(JSON.parse(help.stdout).help).toContain("contextlanes open <lane>");
      const status = spawnSync(process.execPath, [join(out, "cli.mjs"), "status", "--json"], { encoding: "utf8", cwd: out, env });
      expect(status.status).toBe(3);
      // An owner-only command in a lane waits on the owner (exit 4), before anything is asked of the API.
      const remove = spawnSync(process.execPath, [join(out, "cli.mjs"), "delete", "shop/01", "--json"], { encoding: "utf8", cwd: out, env });
      expect(remove.status).toBe(4);
      expect(JSON.parse(remove.stderr)).toMatchObject({ code: "owner_only" });
      const toolbox = spawnSync(process.execPath, [join(out, "toolbox.mjs")], { encoding: "utf8", cwd: out, env: { PATH: "/usr/bin:/bin" }, input: "" });
      expect(toolbox.stderr).toContain("CONTEXTLANES_LANE");
    } finally { await rm(out, { recursive: true, force: true }); }
  }, 60_000);
});
