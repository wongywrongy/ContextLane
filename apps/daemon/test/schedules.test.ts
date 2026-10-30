import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config, EventBus, LaneManager, SetupManager, Store, type Runner } from "@contextlanes/daemon";
import { Schedules } from "../src/schedules.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

describe("scheduled lanes", () => {
  it("writes a persistent timer that runs the CLI, checks the calendar with systemd, and starts the lane on demand", async () => {
    const home = await mkdtemp(join(tmpdir(), "cl-sched-")); roots.push(home);
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "systemd-analyze") return args.at(-1) === "every tuesday-ish" ? Promise.reject(new Error("Failed to parse")) : { stdout: "  Original form: *-*-* 02:00\nNormalized form: *-*-* 02:00:00\n    Next elapse: Sat 2026-10-31 02:00:00 PDT\n" };
      return { stdout: "" };
    };
    const config = Config.parse({ paths: { data: join(home, "data"), lanes: join(home, "lanes") }, lanes: { launchHosts: false } });
    const store = Store.open(":memory:"); const bus = new EventBus();
    store.addProject({ id: "shop", name: "Shop", path: "/shop" });
    const setup = new SetupManager(config, store, run, { path: join(home, "config.toml"), home });
    const lanes = { start: async (req: Record<string, unknown>) => ({ id: "shop/01", ...req }) } as unknown as LaneManager;
    const s = new Schedules({ config, store, lanes, setup, run, home, node: "/usr/bin/node", cli: "/opt/cl/current/apps/cli/dist/main.js" });
    await expect(s.add({ id: "deps", project: "shop", task: "Bump dependencies", agent: "codex", when: "every tuesday-ish" })).rejects.toThrow(/does not understand/);
    const list = await s.add({ id: "deps", project: "shop", task: "Bump dependencies", agent: "codex", when: "*-*-* 02:00" });
    expect(list).toEqual([expect.objectContaining({ id: "deps", next: "Sat 2026-10-31 02:00:00 PDT", lastLane: null })]);
    const timer = await readFile(join(home, ".config/systemd/user/contextlanes-schedule-deps.timer"), "utf8");
    expect(timer).toContain("OnCalendar=*-*-* 02:00\nPersistent=true");
    expect(await readFile(join(home, ".config/systemd/user/contextlanes-schedule-deps.service"), "utf8")).toContain('ExecStart="/usr/bin/node" "/opt/cl/current/apps/cli/dist/main.js" schedule run deps');
    expect(calls).toContainEqual(["systemctl", "--user", "enable", "--now", "contextlanes-schedule-deps.timer"]);
    expect(await s.runNow("deps")).toMatchObject({ task: "Bump dependencies", goal: "Scheduled: deps", agent: "codex", mode: "ask" });
    expect(await s.remove("deps")).toEqual([]);
    await expect(readFile(join(home, ".config/systemd/user/contextlanes-schedule-deps.timer"), "utf8")).rejects.toThrow();
  });
});
