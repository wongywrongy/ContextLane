import { describe, expect, it } from "vitest";
import { DockerSupervisor, UNIT_SH } from "../src/supervisor/index.js";
import { procAddress, publicProcNet } from "../src/supervisor/docker.js";
import { execArgv } from "../src/docker/exec.js";
import type { Runner } from "../src/run.js";

const target = { container: "cl-shop-01", user: "vscode", workdir: "/home/kyle/code/shop.lanes/01-fix", path: "/opt/contextlanes/bin:/usr/bin:/bin", env: { CONTEXTLANES_LANE: "shop/01", CONTEXTLANES_URL: "http://contextlanes:4600" } };

describe("docker exec argv", () => {
  it("passes the user, the folder and the whole environment itself, and a secret only by name", () => {
    expect(execArgv(target, ["tmux", "-V"], { secrets: { CONTEXTLANES_LANE_TOKEN: "cl-lane-secret" } })).toEqual(["exec", "-u", "vscode", "-w", "/home/kyle/code/shop.lanes/01-fix",
      "-e", "PATH=/opt/contextlanes/bin:/usr/bin:/bin", "-e", "TERM=xterm-256color", "-e", "CLAUDE_CONFIG_DIR=/opt/contextlanes-home/claude", "-e", "CODEX_HOME=/opt/contextlanes-home/codex",
      "-e", "CONTEXTLANES_LANE=shop/01", "-e", "CONTEXTLANES_URL=http://contextlanes:4600", "-e", "CONTEXTLANES_LANE_TOKEN", "cl-shop-01", "tmux", "-V"]);
    const argv = execArgv(target, ["true"], { detach: true, interactive: true, user: "0", dir: "/" });
    expect(argv.slice(0, 7)).toEqual(["exec", "-d", "-i", "-u", "0", "-w", "/"]);
    expect(argv.join(" ")).not.toMatch(/privileged|docker\.sock/);
  });
});

describe("the docker supervisor", () => {
  it("runs every action through the unit helper inside the lane, detached only for a service", async () => {
    const calls: { args: string[]; timeout?: number }[] = [];
    const run: Runner = async (_cmd, args, o) => { calls.push({ args, ...(o?.timeout ? { timeout: o.timeout } : {}) }); return { stdout: args.includes("status") ? "active\n41\n42\n" : "" }; };
    const s = new DockerSupervisor(run, target);
    await s.start("contextlanes-env-shop-01-web", { dir: "/w", argv: ["npm", "run", "dev"], env: { PORT: "3000" }, restart: true });
    const start = calls.at(-1)!.args;
    expect(start.slice(0, 2)).toEqual(["exec", "-d"]);
    expect(start).toContain("CL_UNITS=/var/lib/contextlanes-lane/units");
    expect(start).toContain("PORT=3000");
    expect(start.slice(start.indexOf("cl-shop-01") + 1)).toEqual(["sh", "-c", UNIT_SH, "contextlanes-unit", "start", "contextlanes-env-shop-01-web", "1", "npm", "run", "dev"]);
    expect(await s.status("u")).toEqual({ active: true, state: "active", pids: [41, 42] });
    await expect(s.start("bad name", { dir: "/", argv: ["x"], env: {}, restart: false })).rejects.toThrow(/Invalid unit/);
  });

  it("reads listening sockets from /proc/net in the lane's own network namespace", () => {
    expect(procAddress("0100007F:1F90")).toBe("127.0.0.1:8080");
    expect(procAddress("00000000:0BB8")).toBe("0.0.0.0:3000");
    expect(procAddress("00000000000000000000000001000000:0BB8")).toBe("[::1]:3000");
    expect(procAddress("00000000000000000000000000000000:0BB8")).toBe("[::]:3000");
    expect(procAddress("0000000000000000FFFF00000100007F:0050")).toBe("[::ffff:127.0.0.1]:80");
    const net = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000000000000000 100 0 0 10 0",
      "   2: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 100 0 0 10 0",
    ].join("\n");
    expect(publicProcNet(`socket:[111]\nsocket:[222]\n---\n${net}`)).toEqual(["0.0.0.0:3000"]);
  });
});
