import { afterEach, expect, it, vi } from "vitest";
import { postJson } from "../src/api";

afterEach(() => { vi.unstubAllGlobals(); });

it("treats an empty 204 answer (removing a project) as success", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  await expect(postJson("/api/projects/shop", {}, "DELETE")).resolves.toBeUndefined();
});

it("shows the daemon's reason when it refuses", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "This lane is still being set up." }, { status: 409 })));
  await expect(postJson("/api/lanes/shop/01/discard", {})).rejects.toThrow("This lane is still being set up.");
});
