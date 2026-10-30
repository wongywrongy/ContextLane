import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, runCommand } from "@contextlanes/daemon";

// Opt in on a machine with tmux and a PTY; the ordinary suite fakes every command.
it.runIf(process.env.CONTEXTLANES_REAL_TERMINAL === "1")("keeps the real shell and tmux history across browser and daemon disconnects, then attaches the CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-terminal-"));
  const config = Config.parse({ paths: { data: root, lanes: join(root, "lanes") } });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const hosts = new HostLinks({ store, bus });
  const lanes = new LaneManager({ store, bus, config, run: runCommand });
  let app = buildServer({ store, bus, lanes, hosts, config, version: "test" });
  let session: string | undefined;
  try {
    const repo = join(root, "repo");
    await runCommand("git", ["init", "-b", "main", repo]);
    await runCommand("git", ["-c", "user.name=ContextLanes test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Fixture"], { cwd: repo });
    const project = `terminal-${process.pid}`;
    await app.inject({ method: "POST", url: "/api/projects", payload: { path: repo, name: project } });
    const lane = (await app.inject({ method: "POST", url: "/api/lanes", payload: { project, task: "Persistent terminal" } })).json();
    expect(lane.state).toBe("working");
    session = lane.terminal;
    let output = "";
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const ws = new WebSocket(`${address.replace("http:", "ws:")}/api/lanes/${lane.id}/terminal`);
    ws.addEventListener("message", (event) => { output += event.data; });
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    // Text goes through the terminal as keystrokes, never through a command shell API.
    ws.send(JSON.stringify({ type: "input", data: "export CL_TERMINAL_PROOF=still-here\r" }));
    ws.send(JSON.stringify({ type: "input", data: `seq 1 80; printf 'READY_%s\\n' "$CL_TERMINAL_PROOF"\r` }));
    await vi.waitFor(() => expect(output).toContain("READY_still-here"), { timeout: 5000 });
    const closed = once(ws, "close");
    ws.close();
    await closed;
    await runCommand("tmux", ["has-session", "-t", session!]);
    await vi.waitFor(async () => expect((await runCommand("tmux", ["list-clients", "-t", session!, "-F", "#{client_pid}"])).stdout.trim()).toBe(""));
    const history = (await runCommand("tmux", ["capture-pane", "-p", "-S", "-", "-t", session!])).stdout;
    expect(history).toContain("\n1\n2\n");
    expect(history).toContain("\n79\n80\n");
    await app.close();
    app = buildServer({ store, bus, lanes, hosts, config, version: "restarted" });
    output = "";
    const restarted = await app.listen({ host: "127.0.0.1", port: 0 });
    const next = new WebSocket(`${restarted.replace("http:", "ws:")}/api/lanes/${lane.id}/terminal`);
    next.addEventListener("message", (event) => { output += event.data; });
    await once(next, "open");
    await vi.waitFor(() => expect(output).toContain("READY_still-here"));
    next.send(JSON.stringify({ type: "input", data: `printf 'AFTER_%s\\n' "$CL_TERMINAL_PROOF"\r` }));
    await vi.waitFor(() => expect(output).toContain("AFTER_still-here"));
    const shutdown = once(next, "close");
    await app.close();
    await shutdown;
    const beforeCli = (await runCommand("tmux", ["capture-pane", "-p", "-S", "-", "-t", session!])).stdout;
    expect(beforeCli).toContain("\n1\n2\n");
    expect(beforeCli).toContain("AFTER_still-here");

    // Run the actual CLI entry point inside a second PTY, against a loopback daemon.
    app = buildServer({ store, bus, lanes, hosts, config, version: "cli" });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const previousUrl = process.env.CONTEXTLANES_URL;
    process.env.CONTEXTLANES_URL = url;
    const cli = runCommand.terminal!(process.execPath, ["--import", "tsx", "--conditions=source", "apps/cli/src/main.ts", "term", lane.id], { cwd: process.cwd(), cols: 100, rows: 30 });
    if (previousUrl === undefined) delete process.env.CONTEXTLANES_URL;
    else process.env.CONTEXTLANES_URL = previousUrl;
    let cliOutput = "";
    const listener = cli.onData((data) => { cliOutput += data; });
    try {
      await vi.waitFor(() => expect(cliOutput).toContain("AFTER_still-here"), { timeout: 5000 });
      cli.write(`printf 'CLI_%s\\n' "$CL_TERMINAL_PROOF"\r`);
      await vi.waitFor(() => expect(cliOutput).toContain("CLI_still-here"));
      const afterCli = (await runCommand("tmux", ["capture-pane", "-p", "-S", "-", "-t", session!])).stdout;
      expect(afterCli).toContain("\n1\n2\n");
      expect(afterCli).toContain("CLI_still-here");
    } finally {
      listener.dispose();
      cli.kill();
    }
  } finally {
    await app.close();
    if (session) await runCommand("tmux", ["kill-session", "-t", session]);
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
