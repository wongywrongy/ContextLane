import { expect, it, vi } from "vitest";
import { callLaneTool } from "@contextlanes/toolbox";

it("keeps one question ID across polling and a daemon outage, without supplying an answer", async () => {
  vi.useFakeTimers();
  try {
    const calls: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) return Response.json({ pending: true }, { status: 202 });
      if (calls.length === 2) throw new Error("daemon restarting");
      return Response.json({ optionId: "1", label: "Blue" });
    });
    const result = callLaneTool({ daemonUrl: "http://127.0.0.1:4600", lane: "demo/01", token: "cl-lane-test", fetch }, "ask_owner", { question: "Colour?", options: ["Sand", "Blue"] });
    await vi.advanceTimersByTimeAsync(2000);
    expect(await result).toMatchObject({ ok: true, text: '{"optionId":"1","label":"Blue"}' });
    expect(new Set(calls.map((body) => body.requestId)).size).toBe(1);
    expect(calls.every((body) => !("optionId" in body))).toBe(true);
  } finally { vi.useRealTimers(); }
});

it("split_lanes waits for the owner the same way, with one request ID", async () => {
  vi.useFakeTimers();
  try {
    const calls: Record<string, unknown>[] = [];
    const fetch = vi.fn(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return calls.length < 3 ? Response.json({ pending: true }, { status: 202 }) : Response.json({ started: [{ lane: "demo/02", title: "API" }] });
    });
    const result = callLaneTool({ daemonUrl: "http://127.0.0.1:4600", lane: "demo/01", token: "cl-lane-test", fetch }, "split_lanes", { why: "independent", lanes: [] });
    await vi.advanceTimersByTimeAsync(3000);
    expect((await result).text).toContain("demo/02");
    expect(new Set(calls.map((body) => body.requestId)).size).toBe(1);
  } finally { vi.useRealTimers(); }
});
