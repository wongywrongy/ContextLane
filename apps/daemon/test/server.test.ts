import { signedIn } from "./signed-in.js";
import { describe, expect, it } from "vitest";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, type Runner } from "@contextlanes/daemon";

function setup(opts: { fail?: boolean; owner?: string; taken?: string[]; sessions?: string[]; units?: string[] } = {}) {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "git" && args[0] === "branch" && opts.taken?.includes(args[2]!)) return { stdout: `  ${args[2]}\n` };
    if (cmd === "tmux" && args[0] === "list-sessions") return { stdout: (opts.sessions ?? []).join("\n") };
    if (cmd === "systemctl" && args[1] === "list-units") return { stdout: (opts.units ?? []).map((u) => `${u}.service loaded failed failed lane host\n`).join("") };
    if (opts.fail && cmd === "git") throw new Error("not a git repository");
    return { stdout: "" };
  };
  const config = Config.parse({ paths: { data: "/tmp/cl-test", lanes: "/tmp/cl-test/lanes" }, access: { owner: opts.owner ?? null } });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const hosts = new HostLinks({ store, bus });
  const lanes = new LaneManager({ store, bus, config, run });
  const app = signedIn(buildServer({ store, bus, lanes, hosts, config, version: "test" }), store);
  return { app, store, calls };
}

describe("http api", () => {
  it("reports health", async () => {
    const { app } = setup();
    const res = await app.inject({ url: "/api/health" });
    expect(res.json()).toMatchObject({ ok: true, version: "test" });
  });

  it("starts a lane: worktree, terminal, then working", async () => {
    const { app, calls } = setup();
    await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/shuttleworks", name: "ShuttleWorks" } });
    const res = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shuttleworks", task: "Billing phase 0" } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: "shuttleworks/01", state: "working", terminal: "cl-shuttleworks-01", colour: "lc1" });
    const setupCalls = calls.filter((c) => /^(git worktree|tmux new-session)/.test(c));
    expect(setupCalls[0]).toMatch(/^git worktree add -b lane\/01-billing-phase-0 /);
    expect(setupCalls[1]).toMatch(/^tmux new-session -d -s cl-shuttleworks-01 /);

    const events = (await app.inject({ url: "/api/lanes/shuttleworks/01/events" })).json() as { type: string }[];
    expect(events.map((e) => e.type)).toEqual(["lane.created", "lane.state", "lane.state"]);
  });

  it("lists every project's lanes in one request for the home page", async () => {
    const { app } = setup();
    for (const path of ["/code/ara", "/code/shop"]) await app.inject({ method: "POST", url: "/api/projects", payload: { path } });
    await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "ara", task: "Wake word" } });
    await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shop", task: "Cart" } });
    expect((await app.inject({ url: "/api/lanes" })).json().map((l: { id: string }) => l.id).sort()).toEqual(["ara/01", "shop/01"]);
  });

  it("picks the next free branch and terminal when an old lane's branch or tmux session is still there", async () => {
    const { app, calls } = setup({ taken: ["lane/01-billing", "lane/01-billing-2"], sessions: ["cl-shop-01", "other"] });
    await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/shop" } });
    const lane = (await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shop", task: "Billing" } })).json();
    expect(lane).toMatchObject({ state: "working", branch: "lane/01-billing-3", terminal: "cl-shop-01-3" });
    expect(lane.worktree).toMatch(/01-billing-3$/);
    expect(calls.find((c) => c.startsWith("git worktree"))).toMatch(/^git worktree add -b lane\/01-billing-3 /);
  });

  it("gives the host a free unit name when an old unit still holds the lane id", async () => {
    const { app, calls, store } = setup({ units: ["contextlanes-lane-shop-01", "contextlanes-lane-shop-01-2"] });
    await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/shop" } });
    const lane = (await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shop", task: "Billing" } })).json();
    expect(lane).toMatchObject({ state: "working", hostUnit: "contextlanes-lane-shop-01-3", branch: "lane/01-billing-3" });
    expect(store.getLane("shop/01")!.hostUnit).toBe("contextlanes-lane-shop-01-3");
    expect(calls.find((c) => c.startsWith("systemd-run") && c.includes("--unit="))).toContain("--unit=contextlanes-lane-shop-01-3");
    expect(calls.join("\n")).not.toMatch(/systemctl --user (stop|kill|reset-failed)/);
  });

  it("refuses a base branch that git would read as an option", async () => {
    const { app, calls } = setup();
    await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/shop" } });
    for (const base of ["--force", "-b", "a..b", "main branch"]) expect((await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shop", task: "Cart", base } })).statusCode).toBe(400);
    expect(calls.some((c) => c.startsWith("git worktree"))).toBe(false);
  });

  it("marks the lane failed when setup breaks", async () => {
    const { app } = setup({ fail: true });
    await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/ara" } });
    const res = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "ara", task: "Wake word" } });
    expect(res.json()).toMatchObject({ state: "failed" });
  });

  it("answers a permission from the inbox", async () => {
    const { app, store } = setup();
    await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/shuttleworks" } });
    await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "shuttleworks", task: "Billing" } });
    store.appendEvent("shuttleworks/01", { type: "permission.requested", payload: { requestId: "r1", title: "Run npm i", options: [{ id: "allow", label: "Allow once", kind: "allow_once" }] } });
    expect((await app.inject({ url: "/api/inbox" })).json()).toHaveLength(1);
    const res = await app.inject({ method: "POST", url: "/api/answers", payload: { lane: "shuttleworks/01", requestId: "r1", optionId: "allow", via: "phone" } });
    expect(res.statusCode).toBe(202);
    expect((await app.inject({ url: "/api/inbox" })).json()).toHaveLength(0);
  });

  it("rejects a tailnet user who is not the owner", async () => {
    const { app } = setup({ owner: "kyle@example.com" });
    const res = await app.inject({ url: "/api/health", headers: { "tailscale-user-login": "someone@example.com" } });
    expect(res.statusCode).toBe(403);
  });

  it("returns 400 for a bad request", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "Not Valid!" } });
    expect(res.statusCode).toBe(400);
  });

  it("records disconnected controls for replay and rejects bypass modes", async () => {
    const { app, store } = setup();
    await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/demo" } });
    await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Controls" } });
    for (const [action, payload] of [["prompt", { text: "Next", immediate: true }], ["cancel", {}], ["mode", { mode: "plan" }], ["model", { model: "large" }]] as const) {
      const response = await app.inject({ method: "POST", url: `/api/lanes/demo/01/${action}`, payload });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ delivered: false });
    }
    expect(store.pendingCommands("demo/01")).toHaveLength(4);
    for (const mode of ["auto", "bypassPermissions", "agent", "agent-full-access"]) {
      expect((await app.inject({ method: "POST", url: "/api/lanes/demo/01/mode", payload: { mode } })).statusCode).toBe(400);
    }
  });

  it("only accepts an offered option for a pending permission, once", async () => {
    const { app, store } = setup();
    await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/demo" } });
    await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Permission" } });
    store.appendEvent("demo/01", { type: "permission.requested", payload: { requestId: "request", title: "Continue?", options: [{ id: "once", label: "Allow once", kind: "allow_once" }] } });
    const answer = (requestId: string, optionId: string) => app.inject({ method: "POST", url: "/api/answers", payload: { lane: "demo/01", requestId, optionId } });
    expect((await answer("missing", "once")).statusCode).toBe(404);
    expect((await answer("request", "always")).statusCode).toBe(400);
    expect((await answer("request", "once")).statusCode).toBe(202);
    expect((await answer("request", "once")).statusCode).toBe(409);
    expect(store.events("demo/01").filter((e) => e.type === "permission.answered")).toHaveLength(1);
  });

  it("saves, lists and removes a project's shared skills", async () => {
    const { app } = setup();
    await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/skillshop" } });
    const skill = { name: "deploy-check", description: "Check a deploy.", body: "Run the smoke tests." };
    expect((await app.inject({ method: "PUT", url: "/api/projects/skillshop/skills", payload: skill })).json()).toEqual([skill]);
    expect((await app.inject({ url: "/api/projects/skillshop/skills" })).json()).toEqual([skill]);
    expect((await app.inject({ method: "PUT", url: "/api/projects/skillshop/skills", payload: { ...skill, name: "Bad Name" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: "/api/projects/skillshop/skills/deploy-check" })).json()).toEqual([]);
  });
});
