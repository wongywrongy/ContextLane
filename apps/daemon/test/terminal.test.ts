import { EventEmitter, once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, type Runner, type TerminalProcess } from "@contextlanes/daemon";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const events = new EventEmitter();
  const pty: TerminalProcess = {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: (fn) => { events.on("data", fn); return { dispose: () => events.off("data", fn) }; },
    onExit: (fn) => { events.on("exit", fn); return { dispose: () => events.off("exit", fn) }; },
  };
  const run: Runner = Object.assign(vi.fn(async () => ({ stdout: "" })), { terminal: vi.fn(() => pty) });
  const config = Config.parse({ paths: { data: "/tmp/cl-terminal-test", lanes: "/tmp/cl-terminal-test/lanes" }, access: { owner: "kyle@example.com" } });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const hosts = new HostLinks({ store, bus });
  const lanes = new LaneManager({ store, bus, config, run });
  const app = buildServer({ store, bus, lanes, hosts, config, run, version: "test" });
  cleanups.push(async () => { await app.close(); store.close(); });
  await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/demo" } });
  const lane = (await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Terminal" } })).json();
  return { app, store, run, pty, events, lane };
}

describe("lane terminal", () => {
  it("attaches through Runner, streams output, accepts input and resize, and only detaches on close", async () => {
    const { app, store, run, pty, events, lane } = await setup();
    const before = store.events(lane.id);
    const ws = await app.injectWS("/api/lanes/demo/01/terminal", { headers: { host: "contextlanes.test", origin: "https://contextlanes.test", "tailscale-user-login": "kyle@example.com" } });
    expect(run.terminal).toHaveBeenCalledWith("tmux", ["attach-session", "-t", lane.terminal], { cwd: lane.worktree, cols: 80, rows: 24 });
    const output = once(ws, "message");
    events.emit("data", "hello\r\n");
    expect(String((await output)[0])).toBe("hello\r\n");
    ws.send(JSON.stringify({ type: "input", data: "pwd\r" }));
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 32 }));
    await vi.waitFor(() => {
      expect(pty.write).toHaveBeenCalledWith("pwd\r");
      expect(pty.resize).toHaveBeenCalledWith(100, 32);
    });
    const closed = once(ws, "close");
    ws.terminate();
    await closed;
    await vi.waitFor(() => expect(pty.kill).toHaveBeenCalledOnce());
    expect(events.listenerCount("data")).toBe(0);
    expect(events.listenerCount("exit")).toBe(0);
    expect(store.events(lane.id)).toEqual(before);
    expect(vi.mocked(run).mock.calls.some(([cmd, args]) => cmd === "tmux" && args.includes("kill-session"))).toBe(false);
    const second = await app.injectWS("/api/lanes/demo/01/terminal");
    expect(run.terminal).toHaveBeenCalledTimes(2);
    second.terminate();
  });

  it.each(["not json", '{"type":"resize","cols":0,"rows":24}', '{"type":"input","data":42}'])("refuses malformed input: %s", async (input) => {
    const { app, pty } = await setup();
    const ws = await app.injectWS("/api/lanes/demo/01/terminal");
    const closed = once(ws, "close");
    ws.send(input);
    expect((await closed)[0]).toBe(1008);
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.resize).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(pty.kill).toHaveBeenCalledOnce());
  });

  it("detaches if the PTY exits and on daemon shutdown", async () => {
    const { app, pty, events } = await setup();
    const ws = await app.injectWS("/api/lanes/demo/01/terminal");
    const closed = once(ws, "close");
    events.emit("exit", { exitCode: 0 });
    expect((await closed)[0]).toBe(1000);
    expect(pty.kill).not.toHaveBeenCalled();
    const next = await app.injectWS("/api/lanes/demo/01/terminal");
    const shutdown = once(next, "close");
    await app.close();
    await shutdown;
    await vi.waitFor(() => expect(pty.kill).toHaveBeenCalledOnce());
  });

  it("refuses another owner, another origin, invalid ids and missing lanes before spawning", async () => {
    const { app, run } = await setup();
    await expect(app.injectWS("/api/lanes/demo/01/terminal", { headers: { "tailscale-user-login": "someone@example.com" } })).rejects.toThrow("403");
    for (const origin of ["https://untrusted.example", "null", "file://contextlanes.test"]) {
      await expect(app.injectWS("/api/lanes/demo/01/terminal", { headers: { host: "contextlanes.test", origin } })).rejects.toThrow("403");
    }
    await expect(app.injectWS("/api/lanes/demo/01/terminal", { headers: { host: "rebound.example", origin: "http://rebound.example" } })).rejects.toThrow("403");
    await expect(app.injectWS("/api/lanes/demo/99/terminal")).rejects.toThrow("404");
    await expect(app.injectWS("/api/lanes/demo/no/terminal")).rejects.toThrow("400");
    expect(run.terminal).not.toHaveBeenCalled();
  });

  it("reports attach failures without crashing or changing lane state", async () => {
    const { app, run, store } = await setup();
    vi.mocked(run.terminal!).mockImplementation(() => { throw new Error("no PTY"); });
    const ws = await app.injectWS("/api/lanes/demo/01/terminal");
    expect((await once(ws, "close"))[0]).toBe(1011);
    expect(store.getLane("demo/01")?.state).toBe("working");
  });

  it("disconnects a slow browser and releases its attach client", async () => {
    const { app, pty, events } = await setup();
    const ws = await app.injectWS("/api/lanes/demo/01/terminal");
    const [serverSocket] = app.websocketServer.clients;
    vi.spyOn(serverSocket!, "bufferedAmount", "get").mockReturnValue(1_048_577);
    const closed = once(ws, "close");
    events.emit("data", "more output");
    expect((await closed)[0]).toBe(1013);
    expect(pty.kill).toHaveBeenCalledOnce();
  });

  it("refuses binary frames even when the attach client has already exited", async () => {
    const { app, pty } = await setup();
    vi.mocked(pty.kill).mockImplementation(() => { throw new Error("already exited"); });
    const ws = await app.injectWS("/api/lanes/demo/01/terminal");
    const closed = once(ws, "close");
    ws.send(Buffer.from("keystrokes"));
    expect((await closed)[0]).toBe(1008);
    expect(pty.write).not.toHaveBeenCalled();
  });

  it("only accepts a loopback bind address", () => {
    expect(Config.safeParse({ listen: { host: "0.0.0.0" } }).success).toBe(false);
    expect(Config.parse({}).listen.host).toBe("127.0.0.1");
  });
});
