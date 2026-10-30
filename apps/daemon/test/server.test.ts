import { describe, expect, it } from "vitest";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, type Runner } from "@contextlanes/daemon";

function setup(opts: { fail?: boolean; owner?: string } = {}) {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (opts.fail && cmd === "git") throw new Error("not a git repository");
    return { stdout: "" };
  };
  const config = Config.parse({ paths: { data: "/tmp/cl-test", lanes: "/tmp/cl-test/lanes" }, access: { owner: opts.owner ?? null } });
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const hosts = new HostLinks({ store, bus });
  const lanes = new LaneManager({ store, bus, config, run });
  const app = buildServer({ store, bus, lanes, hosts, config, version: "test" });
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
    expect(calls[0]).toMatch(/^git worktree add -b lane\/01-billing-phase-0 /);
    expect(calls[1]).toMatch(/^tmux new-session -d -s cl-shuttleworks-01 /);

    const events = (await app.inject({ url: "/api/lanes/shuttleworks/01/events" })).json() as { type: string }[];
    expect(events.map((e) => e.type)).toEqual(["lane.created", "lane.state", "lane.state"]);
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
    store.appendEvent("shuttleworks/01", { type: "permission.requested", payload: { requestId: "r1", title: "Run npm i", options: [] } });
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
});
