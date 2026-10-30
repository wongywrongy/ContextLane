import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { buildServer, Config, EventBus, HostLinks, LaneManager, Store, type Runner } from "@contextlanes/daemon";

const enabled = process.env.CONTEXTLANES_REAL_BROWSER === "1";

/** A lane preview is the app's hostname on another port: same site, different origin. */
describe.skipIf(!enabled)("preview ports in a real browser", () => {
  it("cannot read the session token or use it", async () => {
    const root = await mkdtemp(join(tmpdir(), "cl-preview-"));
    const config = Config.parse({ paths: { data: root, lanes: join(root, "lanes") } });
    const run: Runner = async () => ({ stdout: "" });
    const store = Store.open(":memory:"); const bus = new EventBus();
    const app = buildServer({ store, bus, lanes: new LaneManager({ store, bus, config, run }), hosts: new HostLinks({ store, bus }), config, version: "test", run });
    const seen: unknown[] = [];
    app.addHook("onResponse", async (req, reply) => { if (req.url === "/api/inbox") seen.push([req.headers.authorization, req.headers.cookie, reply.statusCode]); });
    const appUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const preview = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<title>preview</title>"); });
    await new Promise<void>((resolve) => preview.listen(0, "127.0.0.1", resolve));
    const previewUrl = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
    const browser = await chromium.launch(process.env.CHROMIUM_BIN ? { executablePath: process.env.CHROMIUM_BIN } : {});
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${appUrl}/api/health`);
      const token = store.ownerSession();
      await page.evaluate((t) => localStorage.setItem("cl-session", t), token);
      await page.goto(previewUrl);
      const stolen = await page.evaluate(async (url) => {
        const response = await fetch(`${url}/api/inbox`, { mode: "no-cors", credentials: "include" }).catch(() => null);
        return { keys: Object.keys(localStorage), cookie: document.cookie, type: response?.type ?? "refused" };
      }, appUrl);
      expect(stolen).toMatchObject({ keys: [], cookie: "" });
      expect(seen).toEqual([[undefined, undefined, 401]]);
      await page.goto(`${appUrl}/api/health`);
      expect(await page.evaluate(() => localStorage.getItem("cl-session"))).toBe(token);
    } finally {
      await browser.close();
      await app.close();
      await new Promise((resolve) => preview.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
