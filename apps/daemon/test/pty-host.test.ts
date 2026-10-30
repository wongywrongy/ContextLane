import { describe, expect, it } from "vitest";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, runCommand } from "@contextlanes/daemon";
import { ptyHostTerminal, type TerminalProcess } from "../src/run.js";

function collect(term: TerminalProcess) {
  let out = "";
  term.onData((t) => { out += t; });
  const exit = new Promise<{ exitCode: number; signal?: number; error?: string }>((resolve) => term.onExit(resolve));
  return { output: () => out, exit };
}

describe("PTY host", () => {
  it("runs a command on a real terminal and reports its exit code", async () => {
    const t = collect(ptyHostTerminal("sh", ["-c", "test -t 0 && echo on-a-tty; exit 3"], { cwd: "/tmp", cols: 80, rows: 24 }));
    expect((await t.exit).exitCode).toBe(3);
    expect(t.output()).toContain("on-a-tty");
  });

  it("passes typed input through and applies the window size", async () => {
    const term = ptyHostTerminal("sh", ["-c", "stty size; read line; echo got:$line; sleep 0.2; stty size"], { cwd: "/tmp", cols: 90, rows: 30 });
    const t = collect(term);
    await expect.poll(t.output).toContain("30 90");
    term.resize(120, 40);
    term.write("hello\r");
    expect((await t.exit).exitCode).toBe(0);
    expect(t.output()).toContain("got:hello");
    expect(t.output()).toContain("40 120");
  });

  it("keeps multi-byte characters whole across reads", async () => {
    const t = collect(ptyHostTerminal("sh", ["-c", "printf 'caf\\303\\251 \\342\\234\\223'"], { cwd: "/tmp", cols: 80, rows: 24 }));
    await t.exit;
    expect(t.output()).toContain("café ✓");
  });

  it("hangs up the command when the terminal is closed", async () => {
    const term = ptyHostTerminal("sleep", ["30"], { cwd: "/tmp", cols: 80, rows: 24 });
    const t = collect(term);
    term.kill();
    const e = await t.exit;
    expect(e.error).toBeUndefined();
  });

  it("a crashed terminal closes alone; the daemon keeps answering", async () => {
    const store = Store.open(":memory:");
    const config = Config.parse({});
    const bus = new EventBus();
    const server = buildServer({ store, config, bus, hosts: new HostLinks({ store, bus }), lanes: new LaneManager({ store, config, bus, run: runCommand }), version: "test" });
    try {
      // The host prints its own pid through the terminal, then gets a SIGSEGV as if it had crashed.
      const term = ptyHostTerminal("sh", ["-c", "kill -SEGV $PPID; sleep 5"], { cwd: "/tmp", cols: 80, rows: 24 });
      const e = await collect(term).exit;
      expect(e.error).toMatch(/The terminal stopped \(SIGSEGV\)/);
      expect((await server.inject("/api/health")).statusCode).toBe(200);
    } finally {
      await server.close(); store.close();
    }
  });

  it("says so when the terminal cannot start", async () => {
    const e = await collect(ptyHostTerminal("sh", [], { cwd: "/tmp", cols: 80, rows: 24 }, undefined, "/nonexistent/python3")).exit;
    expect(e.error).toMatch(/could not start/);
  });
});
