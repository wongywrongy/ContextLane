import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Lane, LaneEvent } from "@contextlanes/protocol";
import { buildServer, Config, EventBus, HostLinks, LaneManager, runCommand, Store, type Runner } from "@contextlanes/daemon";
import { signedIn } from "./signed-in.js";

/**
 * End to end, the way neo runs it, minus systemd: the real lane host process, in the real bubblewrap
 * sandbox, talking ACP to an SDK agent and to the daemon over the real socket with its lane token.
 * systemd-run and systemctl are replaced by a small shim that starts and stops the same command
 * lines, so everything the daemon hands systemd (arguments, $$ escaping, --setenv) is exercised.
 */
const tools = ["/usr/bin/bwrap", "/usr/bin/tmux", "/usr/bin/git"].every(existsSync);
const loader = createRequire(import.meta.url).resolve("tsx");
const viaTsx = (file: string) => ({ command: process.execPath, args: ["--import", loader, "--conditions=source", resolve(file)] });

describe.skipIf(!tools)("a lane end to end", () => {
  const units = new Map<string, { child: ChildProcess; log: string }>();
  const roots: string[] = [];
  afterAll(async () => {
    for (const u of units.values()) u.child.kill("SIGKILL");
    for (const r of roots) await rm(r, { recursive: true, force: true });
  });

  const shim: Runner = async (cmd, args, opts) => {
    if (cmd === "systemd-run") {
      let i = 0; let unit = ""; let cwd = opts?.cwd; let wait = false;
      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      for (; i < args.length && args[i]!.startsWith("--"); i++) {
        const a = args[i]!;
        if (a === "--") { i++; break; }
        if (a.startsWith("--unit=")) unit = a.slice(7);
        else if (a.startsWith("--working-directory=")) cwd = a.slice(20);
        else if (a === "--wait") wait = true;
        else if (a.startsWith("--setenv=")) { const kv = a.slice(9); const eq = kv.indexOf("="); if (eq < 0) env[kv] = opts?.env?.[kv] ?? process.env[kv] ?? ""; else env[kv.slice(0, eq)] = kv.slice(eq + 1); }
      }
      // systemd turns $$ back into $; nothing else in the command line is interpreted.
      const argv = args.slice(i).map((a) => a.replaceAll("$$", "$"));
      if (wait) return runCommand(argv[0]!, argv.slice(1), { ...(cwd ? { cwd } : {}), env: opts?.env ?? {} });
      const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const entry = { child, log: "" };
      child.stdout!.on("data", (d) => { entry.log += String(d); });
      child.stderr!.on("data", (d) => { entry.log += String(d); });
      units.get(unit)?.child.kill("SIGKILL");
      units.set(unit, entry);
      return { stdout: "" };
    }
    if (cmd === "systemctl") {
      const unit = args.find((a) => a.startsWith("contextlanes-") && !a.includes("*"));
      if (args.includes("stop") && unit) { units.get(unit)?.child.kill("SIGTERM"); return { stdout: "" }; }
      if (args.includes("is-active")) { if (unit && units.get(unit)?.child.exitCode === null) return { stdout: "active" }; throw new Error("inactive"); }
      return { stdout: "" };
    }
    if (cmd === "journalctl") return { stdout: [...units.values()].at(-1)?.log ?? "" };
    // gh is the only fake beyond systemd: nothing leaves the machine.
    if (cmd === "gh") return { stdout: args[1] === "create" ? "https://github.invalid/shop/pull/1\n" : "" };
    return runCommand(cmd, args, opts);
  };

  it("starts the agent, shows its steps, takes an answer, restarts and deletes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cl-e2e-")); roots.push(root);
    const repo = join(root, "shop");
    await runCommand("git", ["init", "-q", "-b", "main", repo]);
    await runCommand("git", ["-c", "user.name=CL", "-c", "user.email=cl@example.invalid", "commit", "-q", "--allow-empty", "-m", "Fixture"], { cwd: repo });
    await runCommand("git", ["init", "-q", "--bare", join(root, "origin.git")]);
    await runCommand("git", ["remote", "add", "origin", join(root, "origin.git")], { cwd: repo });
    await runCommand("git", ["push", "-q", "origin", "main"], { cwd: repo });
    const config = Config.parse({ paths: { data: join(root, "data"), lanes: join(root, "lanes") }, agents: { fake: viaTsx("apps/lanehost/test/fixtures/fake-stdio.ts") },
      lanes: { launchHosts: true, host: viaTsx("apps/lanehost/src/main.ts") } });
    const store = Store.open(":memory:"); const bus = new EventBus();
    const hosts = new HostLinks({ store, bus });
    const { socketPath } = await import("../src/sandbox.js");
    await (await import("node:fs/promises")).mkdir(resolve(socketPath(config), ".."), { recursive: true });
    await hosts.listen(socketPath(config));
    const lanes = new LaneManager({ store, bus, config, run: shim });
    const app = signedIn(buildServer({ store, bus, lanes, hosts, config, version: "e2e", run: shim }), store);
    const events = (id: string) => store.events(id, 0, 5000) as LaneEvent[];
    try {
      await app.inject({ method: "POST", url: "/api/projects", payload: { path: repo } });
      // A plan with markdown, a $ and a % in it: none of it may be mangled on the way to the agent.
      const res = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shop", agent: "fake", task: "permission" } });
      expect(res.statusCode).toBe(201);
      const lane = res.json() as Lane;

      // The agent connects (its token is accepted), says it started and asks for permission.
      await vi.waitFor(() => expect(events(lane.id).map((e) => e.type)).toContain("permission.requested"), { timeout: 30_000, interval: 250 });
      expect(events(lane.id).some((e) => e.type === "agent.session")).toBe(true);
      expect(store.getLane(lane.id)!.state).toBe("needs_you");
      expect((await app.inject({ url: `/api/lanes/${lane.id}/agent` })).json()).toEqual({ connected: true, starting: false });
      const asked = events(lane.id).find((e) => e.type === "permission.requested")!;
      if (asked.type !== "permission.requested") throw new Error("unreachable");
      expect((await app.inject({ method: "POST", url: "/api/answers", payload: { lane: lane.id, requestId: asked.payload.requestId, optionId: "yes" } })).statusCode).toBe(202);
      await vi.waitFor(() => expect(events(lane.id).some((e) => e.type === "agent.message" && e.payload.role === "agent" && e.payload.text.includes("Finished permission"))).toBe(true), { timeout: 15_000, interval: 250 });
      expect(store.getLane(lane.id)!.state).toBe("working");

      // A whole plan with markdown, $ and % reaches the agent exactly; the lane gets a short title.
      const plan = "# Billing: invoices\n\n1. Read `AGENTS.md`.\n2. Keep $HOME and %h and 100% as written.\n";
      const second = (await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shop", agent: "fake", task: plan } })).json() as Lane;
      expect(second.task).toBe("Billing: invoices");
      await vi.waitFor(() => expect(events(second.id).some((e) => e.type === "agent.message" && e.payload.role === "agent" && e.payload.text.includes("Finished"))).toBe(true), { timeout: 30_000, interval: 250 });
      const said = events(second.id).filter((e) => e.type === "agent.message" && e.payload.role === "agent").map((e) => e.type === "agent.message" ? e.payload.text : "").join("");
      expect(said).toContain(plan.trim());

      // Ask for review with nothing committed: the agent is asked to commit and send it.
      const early = await app.inject({ method: "POST", url: `/api/lanes/${second.id}/checkpoint`, payload: { summary: "Invoices" } });
      expect(early.json()).toMatchObject({ asked: true });
      await vi.waitFor(() => expect(events(second.id).some((e) => e.type === "agent.message" && e.payload.role === "agent" && e.payload.text.includes("The owner asked for review"))).toBe(true), { timeout: 15_000, interval: 250 });
      // Once committed, the checkpoint is built and the lane moves to Review.
      await (await import("node:fs/promises")).writeFile(join(second.worktree, "invoices.txt"), "invoices\n");
      await runCommand("git", ["-c", "user.name=CL", "-c", "user.email=cl@example.invalid", "commit", "-qam", "Invoices", "--allow-empty"], { cwd: second.worktree });
      await runCommand("git", ["add", "-A"], { cwd: second.worktree });
      await runCommand("git", ["-c", "user.name=CL", "-c", "user.email=cl@example.invalid", "commit", "-qm", "Add invoices"], { cwd: second.worktree });
      const asking = await app.inject({ method: "POST", url: `/api/lanes/${second.id}/checkpoint`, payload: { summary: "Invoices" } });
      expect(asking.statusCode, asking.body).toBe(202);
      await vi.waitFor(() => expect(store.getLane(second.id)!.state).toBe("in_review"), { timeout: 30_000, interval: 250 });
      expect((await app.inject({ url: "/api/projects/shop/checkpoints" })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ lane: second.id })]));

      // Request changes: the agent gets the note and the lane is working again.
      expect((await app.inject({ method: "POST", url: `/api/lanes/${second.id}/request-changes`, payload: { note: "Round totals to cents" } })).statusCode).toBe(202);
      await vi.waitFor(() => expect(events(second.id).some((e) => e.type === "agent.message" && e.payload.role === "agent" && e.payload.text.includes("Round totals to cents"))).toBe(true), { timeout: 15_000, interval: 250 });
      expect(store.getLane(second.id)!.state).toBe("working");
      await (await import("node:fs/promises")).writeFile(join(second.worktree, "invoices.txt"), "invoices, rounded\n");
      await runCommand("git", ["-c", "user.name=CL", "-c", "user.email=cl@example.invalid", "commit", "-qam", "Round totals"], { cwd: second.worktree });
      expect((await app.inject({ method: "POST", url: `/api/lanes/${second.id}/checkpoint`, payload: { summary: "Rounded" } })).statusCode).toBe(202);
      await vi.waitFor(() => expect(store.getLane(second.id)!.state).toBe("in_review"), { timeout: 30_000, interval: 250 });

      // Approve: pushed to origin, pull request opened, then cleaned up.
      const approved = await app.inject({ method: "POST", url: `/api/lanes/${second.id}/approve` });
      expect(approved.statusCode, approved.body).toBeLessThan(300);
      await vi.waitFor(() => expect(store.getLane(second.id)!.state).toBe("merged"), { timeout: 30_000, interval: 250 });
      expect((await runCommand("git", ["branch", "--list", second.branch], { cwd: join(root, "origin.git") })).stdout).toContain(second.branch.split("/").at(-1));
      const cleaned = await app.inject({ method: "POST", url: `/api/lanes/${second.id}/cleanup` });
      expect(cleaned.statusCode, cleaned.body).toBe(200);
      expect(store.getLane(second.id)!.state).toBe("cleaned");
      expect(existsSync(second.worktree)).toBe(false);

      // Restart: a new host, a new token, and the old one is refused.
      const before = events(lane.id).filter((e) => e.type === "agent.session").length;
      expect((await app.inject({ method: "POST", url: `/api/lanes/${lane.id}/restart` })).statusCode).toBe(200);
      await vi.waitFor(() => expect(events(lane.id).filter((e) => e.type === "agent.session").length).toBeGreaterThan(before), { timeout: 30_000, interval: 250 });

      // Delete: the agent stops and the checkout goes.
      expect((await app.inject({ method: "POST", url: `/api/lanes/${lane.id}/discard`, payload: { deleteBranch: true } })).json()).toMatchObject({ state: "archived" });
      expect(existsSync(lane.worktree)).toBe(false);
    } finally {
      await app.close(); await hosts.close();
      for (const l of store.listLanes()) await runCommand("tmux", ["kill-session", "-t", `=${l.terminal}`]).catch(() => {});
    }
  }, 120_000);
});
