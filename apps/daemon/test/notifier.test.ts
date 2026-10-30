import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationConfig } from "@contextlanes/protocol";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Notifier, quietNow, Store, type Runner } from "@contextlanes/daemon";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup() {
  const store = Store.open(":memory:");
  const bus = new EventBus();
  const config = Config.parse({ lanes: { launchHosts: false }, access: { owner: "kyle@example.com" }, paths: { lanes: "/tmp/cl-notify-test" } });
  const run: Runner = async () => ({ stdout: "" });
  const hosts = new HostLinks({ store, bus });
  const lanes = new LaneManager({ store, bus, config, run });
  const app = buildServer({ store, bus, config, hosts, lanes, run, version: "test" });
  cleanup.push(async () => { await app.close(); store.close(); });
  await app.inject({ method: "POST", url: "/api/projects", payload: { path: "/code/demo" } });
  await app.inject({ method: "POST", url: "/api/lanes", payload: { project: "demo", task: "Notify" } });
  store.appendEvent("demo/01", { type: "permission.requested", payload: { requestId: "request", title: "Run a check?", options: [
    { id: "yes", label: "Allow once", kind: "allow_once" }, { id: "always", label: "Allow always", kind: "allow_always" }, { id: "no", label: "Deny", kind: "reject_once" },
  ] } });
  store.setLaneState("demo/01", "needs_you");
  const answer = async (token: string) => (await app.inject({ method: "POST", url: "/api/answers", headers: { authorization: `Bearer ${token}` }, payload: {} })).statusCode === 202;
  return { store, bus, app, answer };
}

it("defers quiet-hour notifications, retries after quiet hours, and never answers by time", async () => {
  const fixture = await setup();
  const calls: { url: string; body: any }[] = [];
  let now = new Date("2026-01-01T23:00:00Z");
  const notifier = new Notifier({ ...fixture, now: () => now,
    config: NotificationConfig.parse({ publicUrl: "https://lanes.example", ntfy: { topic: "secret-topic" }, quiet: { start: "22:00", end: "08:00", timeZone: "UTC" } }),
    fetch: vi.fn(async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json({}); }) });
  cleanup.push(() => notifier.close());
  await notifier.flush();
  expect(calls).toHaveLength(0);
  expect(fixture.store.inbox()).toHaveLength(1);
  expect(fixture.store.getLane("demo/01")?.state).toBe("needs_you");
  now = new Date("2026-01-02T09:00:00Z");
  await notifier.flush();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.actions.map((a: any) => a.label)).toEqual(["Allow once", "Deny"]);
  expect(fixture.store.inbox()).toHaveLength(1);
  await notifier.flush();
  expect(calls).toHaveLength(1);
  expect(quietNow({ start: "08:00", end: "17:00", timeZone: "America/New_York" }, new Date("2026-01-02T15:00:00Z"))).toBe(true);
  expect(quietNow({ start: "08:00", end: "08:00", timeZone: "UTC" }, now)).toBe(false);
});

it("a capability can answer only its recorded option, once, and cannot override another tailnet owner", async () => {
  const { app, store } = await setup();
  const token = store.action("demo/01", "request", "no", "ntfy");
  const invoke = (headers: Record<string, string>) => app.inject({ method: "POST", url: "/api/answers", headers, payload: { lane: "other/01", requestId: "different", optionId: "always" } });
  expect((await invoke({ authorization: `Bearer ${token}`, "tailscale-user-login": "other@example.com" })).statusCode).toBe(403);
  expect((await invoke({ authorization: `Bearer cl-action-${"x".repeat(43)}` })).statusCode).toBe(401);
  expect((await invoke({ authorization: `Bearer ${token}` })).statusCode).toBe(202);
  expect(store.answer("demo/01", "request")).toMatchObject({ optionId: "no", by: "phone" });
  expect((await invoke({ authorization: `Bearer ${token}` })).statusCode).toBe(409);
  expect(store.inbox()).toHaveLength(0);
});

it("checks Telegram sender and chat before sending an action through /api/answers and persists its cursor", async () => {
  const fixture = await setup();
  const token = fixture.store.action("demo/01", "request", "yes", "telegram");
  const requests: { url: string; body: any }[] = [];
  const notifier = new Notifier({ ...fixture, config: NotificationConfig.parse({ telegram: { botToken: "not-a-real-token", ownerId: "7", chatId: "9" } }),
    fetch: vi.fn(async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      if (String(url).endsWith("getUpdates")) return Response.json({ ok: true, result: [
        { update_id: 1, callback_query: { id: "other-owner", from: { id: 8 }, message: { chat: { id: 9 } }, data: token } },
        { update_id: 2, callback_query: { id: "other-chat", from: { id: 7 }, message: { chat: { id: 10 } }, data: token } },
        { update_id: 3, callback_query: { id: "owner", from: { id: 7 }, message: { chat: { id: 9 } }, data: token } },
      ] });
      return Response.json({ ok: true });
    }) });
  cleanup.push(() => notifier.close());
  await notifier.pollOnce();
  expect(fixture.store.answer("demo/01", "request")).toMatchObject({ optionId: "yes", by: "telegram" });
  expect(fixture.store.events("demo/01").filter((e) => e.type === "permission.answered")).toHaveLength(1);
  expect(fixture.store.telegramOffset()).toBe(4);
  expect(requests.filter((r) => r.url.endsWith("answerCallbackQuery")).map((r) => r.body.text)).toEqual(["Not pending, or not your request.", "Not pending, or not your request.", "Answered."]);
});

it("retries provider failures without answering and removes expired push subscriptions", async () => {
  const fixture = await setup();
  fixture.store.saveSubscription({ endpoint: "https://push.example/subscription", keys: { p256dh: "P".repeat(87), auth: "A".repeat(22) } });
  let fail = true;
  const notifier = new Notifier({ ...fixture, config: NotificationConfig.parse({ publicUrl: "https://lanes.example", ntfy: { topic: "topic" }, webPush: { subject: "mailto:kyle@example.com", publicKey: "key", privateKey: "private" } }),
    fetch: vi.fn(async () => fail ? new Response("unavailable", { status: 503 }) : Response.json({})),
    push: vi.fn(async () => { throw Object.assign(new Error("gone"), { statusCode: 410 }); }) });
  cleanup.push(() => notifier.close());
  await notifier.flush();
  expect(fixture.store.inbox()).toHaveLength(1);
  expect(fixture.store.subscriptions()).toHaveLength(0);
  expect(fixture.store.notified("demo/01", "request", "ntfy")).toBe(false);
  fail = false;
  await notifier.flush();
  expect(fixture.store.notified("demo/01", "request", "ntfy")).toBe(true);
  expect(fixture.store.inbox()).toHaveLength(1);
});

it("validates subscriptions and retries one toolbox question ID until the owner answers", async () => {
  const { app, store } = await setup();
  expect((await app.inject({ method: "POST", url: "/api/push/subscriptions", payload: { endpoint: "http://unsafe.example", keys: {} } })).statusCode).toBe(400);
  const payload = { requestId: randomUUID(), question: "Which colour?", options: ["Sand", "Blue"] };
  const ask = () => app.inject({ method: "POST", url: "/api/lanes/demo/01/tools/ask_owner", payload });
  expect((await ask()).statusCode).toBe(202);
  expect((await ask()).statusCode).toBe(202);
  expect(store.events("demo/01").filter((e) => e.type === "permission.requested" && e.payload.requestId === payload.requestId)).toHaveLength(1);
  await app.inject({ method: "POST", url: "/api/answers", payload: { lane: "demo/01", requestId: payload.requestId, optionId: "1" } });
  expect((await ask()).json()).toEqual({ optionId: "1", label: "Blue" });
  expect(store.pendingCommands("demo/01")).toHaveLength(0);
});
