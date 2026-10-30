import Module from "node:module";
import { expect, it, vi } from "vitest";

it("starts the daemon and serves health when the native PTY module cannot load", async () => {
  const load = Module._load;
  const native = vi.spyOn(Module, "_load").mockImplementation(function (id, ...args) {
    if (id === "node-pty") throw new Error("native PTY build missing");
    return load.call(this, id, ...args);
  });
  let app: { close(): Promise<void> } | undefined;
  try {
    const { buildServer, Config, EventBus, HostLinks, LaneManager, Store, runCommand } = await import("@contextlanes/daemon");
    expect(native.mock.calls.some(([id]) => id === "node-pty")).toBe(false);
    const store = Store.open(":memory:");
    const config = Config.parse({});
    const bus = new EventBus();
    const hosts = new HostLinks({ store, bus });
    const lanes = new LaneManager({ store, config, bus, run: runCommand });
    const server = buildServer({ store, config, bus, hosts, lanes, version: "test" });
    app = server;
    expect((await server.inject("/api/health")).statusCode).toBe(200);
    expect(() => runCommand.terminal!("tmux", [], { cwd: "/tmp", cols: 80, rows: 24 })).toThrow("native PTY build missing");
    expect((await server.inject("/api/health")).statusCode).toBe(200);
    await server.close();
    store.close();
  } finally {
    await app?.close();
    native.mockRestore();
  }
});
