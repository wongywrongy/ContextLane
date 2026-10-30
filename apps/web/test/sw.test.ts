import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

it("a push displays choices; only a user notification click sends a single answer", async () => {
  const handlers = new Map<string, (event: any) => void>();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => {});
  const fetch = vi.fn(async () => new Response("{}", { status: 202 }));
  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { URL, fetch, self: {
    addEventListener: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    registration: { showNotification }, clients: { openWindow }, location: { origin: "https://lanes.example" },
  } });
  const message = { title: "Needs you", body: "Run a check?", tag: "demo/01#r", url: "/p/demo/work", actions: [{ label: "Allow once", token: "one-choice" }] };
  let work: Promise<unknown>;
  handlers.get("push")!({ data: { json: () => message }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
  await work!;
  expect(showNotification).toHaveBeenCalledWith("Needs you", expect.objectContaining({ actions: [{ action: "one-choice", title: "Allow once" }] }));
  expect(fetch).not.toHaveBeenCalled();
  const close = vi.fn();
  handlers.get("notificationclick")!({ action: "one-choice", notification: { data: message, close }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
  await work!;
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith("/api/answers", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer one-choice" }), body: "{}" }));
  expect(openWindow).not.toHaveBeenCalled();
  fetch.mockResolvedValueOnce(new Response("{}", { status: 409 }));
  handlers.get("notificationclick")!({ action: "one-choice", notification: { data: message, close }, waitUntil: (promise: Promise<unknown>) => { work = promise; } });
  await work!;
  expect(openWindow).toHaveBeenCalledWith("https://lanes.example/p/demo/work");
});
