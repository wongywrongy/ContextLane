import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Config, sandbox } from "@contextlanes/daemon";
import { laneCommandDir } from "../src/lanes/cli.js";

const exec = promisify(execFile);
const enabled = process.env.CONTEXTLANES_REAL_SANDBOX === "1";
const repo = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The agent in a CLI lane runs `contextlanes` inside bubblewrap, which hides the data folder. A wrapper
 * through <data>/current (what ~/.local/bin points at) cannot run there; the lane's own wrapper can.
 */
describe.skipIf(!enabled)("the contextlanes command inside the real sandbox", () => {
  it("reaches the daemon with the lane token, and only through the lane's own wrapper", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cl-cli-sandbox-")));
    const data = join(root, "data");
    const laneDir = join(data, "cli", "demo-01");
    await mkdir(join(data, "releases"), { recursive: true });
    await mkdir(laneDir, { recursive: true });
    await writeFile(join(data, "setup-token"), "owner-secret");
    await symlink(repo, join(data, "current"));
    const seen: { url?: string; auth?: string }[] = [];
    const daemon = createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ lane: "demo/01", recipeHash: "x", setup: null, startedAt: null, error: null, services: [] }));
    });
    daemon.listen(0, "127.0.0.1"); await once(daemon, "listening");
    const config = Config.parse({ paths: { data, lanes: join(root, "lanes") } });
    const env = { PATH: process.env.PATH!, CONTEXTLANES_URL: `http://127.0.0.1:${(daemon.address() as { port: number }).port}`, CONTEXTLANES_LANE: "demo/01", CONTEXTLANES_LANE_TOKEN: "lane-secret" };
    const inLane = (command: string[]) => exec(sandbox(config, { laneData: laneDir })[0]!, [...sandbox(config, { laneData: laneDir }).slice(1), ...command], { env }).then((r) => ({ ok: true, out: r.stdout }), (e: { stdout?: string; stderr?: string }) => ({ ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }));
    try {
      const viaCurrent = await laneCommandDir(join(root, "through-current"), process.execPath, join(data, "current", "apps/cli/dist/main.js"));
      expect((await inLane(["/bin/sh", "-c", `${join(viaCurrent, "contextlanes")} env --json`])).ok).toBe(false);

      const bin = await laneCommandDir(laneDir);
      const result = await inLane([join(bin, "contextlanes"), "env", "--json"]);
      expect(result.ok, result.out).toBe(true);
      expect(JSON.parse(result.out)).toMatchObject({ lane: "demo/01", services: [] });
      expect(seen.at(-1)).toEqual({ url: "/api/lanes/demo/01/tools/env_status", auth: "Bearer lane-secret" });
      expect((await inLane(["cat", join(data, "setup-token")])).ok).toBe(false);
    } finally {
      daemon.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
