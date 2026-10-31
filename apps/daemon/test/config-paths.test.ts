import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

describe("config", () => {
  it("runs lanes on the running release's host and toolbox, whatever an old config saved", async () => {
    const root = await mkdtemp(join(tmpdir(), "cl-cfg-")); roots.push(root);
    const path = join(root, "config.toml");
    await writeFile(path, `[lanes]\nmaxConcurrent = 3\n[lanes.host]\ncommand = "/old/node"\nargs = ["/home/kyle/.local/share/contextlanes/app/apps/lanehost/dist/main.js"]\n[lanes.toolbox]\ncommand = "/old/node"\nargs = ["/home/kyle/.local/share/contextlanes/app/packages/toolbox/dist/main.js"]\n`);
    const config = loadConfig(path);
    expect(config.lanes.maxConcurrent).toBe(3);
    expect(config.lanes.host.args[0]).not.toContain("/contextlanes/app/");
    expect(config.lanes.host.command).toBe(process.execPath);
    await saveConfig(config, path);
    const saved = await readFile(path, "utf8");
    expect(saved).not.toContain("lanehost/dist");
    expect(saved).not.toContain("toolbox/dist");
  });
});
