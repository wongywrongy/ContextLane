import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { expect, it, vi } from "vitest";
import { EventBus, HostLinks, Store } from "@contextlanes/daemon";

it("keeps ACP observations from overwriting or releasing a daemon repair pause", async () => {
  const store = Store.open(":memory:"), bus = new EventBus();
  const hosts = new HostLinks({ store, bus });
  store.addProject({ id: "demo", name: "Demo", path: "/tmp/demo" });
  const lane = "demo/01";
  store.insertLane({ id: lane, project: "demo", n: 1, task: "Fix acceptance", kind: "acp", agent: "codex", goal: null, model: null, mode: "ask", auto: true, branch: "lane/01", base: "main", worktree: "/tmp/demo/lane", terminal: "t", hostUnit: null, state: "working", colour: "lc1" });
  const requestId = `checkpoint-repair-${randomUUID()}`;
  store.appendEvent(lane, { type: "checkpoint.repair_paused", payload: { requestId } });
  const paused = { requestId, kind: "question" as const, title: "Checks failed after two repairs", options: [{ id: "reviewed", label: "Ready to continue", kind: "allow_once" as const }] };
  store.appendEvent(lane, { type: "permission.requested", payload: paused });
  store.setLaneState(lane, "needs_you");
  const responses: Record<string, unknown>[] = [];
  // Keep the real line parser/auth/event pipeline; substitute only the OS socket.
  const socket = new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) { responses.push(JSON.parse(chunk.toString())); callback(); } });
  (hosts as unknown as { accept(socket: Socket): void }).accept(socket as Socket);
  const send = async (message: object) => {
    const before = responses.length;
    socket.push(Buffer.from(`${JSON.stringify(message)}\n`));
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(before));
    return responses.at(-1)!;
  };
  const observe = (event: object) => send({ eventId: randomUUID(), event });
  try {
    expect(await send({ hello: lane, token: store.mintLaneToken(lane) })).toEqual({ ready: true });
    expect(await observe({ type: "permission.requested", payload: { requestId, title: "Harmless tool permission", options: [{ id: "reviewed", label: "Allow", kind: "allow_once" }], tool: { kind: "execute", command: "pnpm test", paths: [] } } })).toMatchObject({ error: expect.stringContaining("reserved") });
    expect(store.permission(lane, requestId)).toEqual(paused);
    expect(store.answered(lane, requestId)).toBe(false);
    expect(await observe({ type: "owner.guidance", payload: { kind: "prompt" } })).toHaveProperty("error");
    expect(await observe({ type: "checkpoint.repair_paused", payload: { requestId: "forged" } })).toHaveProperty("error");
    await observe({ type: "agent.error", payload: { message: "Transient host failure" } });
    await observe({ type: "agent.turn", payload: { active: true } });
    expect(store.getLane(lane)!.state).toBe("needs_you");
    expect(store.inbox()).toMatchObject([{ lane, kind: "question", title: paused.title }]);
    expect(store.eventsOfType(["owner.guidance"])).toEqual([]);
  } finally { await hosts.close(); store.close(); }
});
