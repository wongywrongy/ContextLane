import { afterEach, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import qr from "qrcode-terminal";
import { ClientError } from "../src/client.js";
import { setupOutput, addProject } from "../src/setup.js";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const c of cleanups.splice(0)) await c(); });
it("turns shell proof into a ten-minute link and QR with the same URL, without printing the local credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl-cli-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const controlFile = join(root, "setup-token"); await writeFile(controlFile, "private-shell-proof");
  const url = `https://neo.test.ts.net/setup#signin=${"a".repeat(43)}`;
  const http = vi.fn<typeof fetch>(async (path, init) => {
    if (String(path).endsWith("/status")) return Response.json({ claimed: false, authorized: false, hasPasskey: false, hasLane: false, tailnetLogin: null, publicUrl: null, controlFile });
    if (String(path).endsWith("/prove")) {
      expect(init?.headers).not.toHaveProperty("authorization");
      return Response.json({ proof: createHmac("sha256", "private-shell-proof").update(`contextlanes-cli:${JSON.parse(String(init?.body)).nonce}`).digest("base64url") });
    }
    expect(init?.headers).toMatchObject({ authorization: "Bearer private-shell-proof" });
    return Response.json({ url, expiresAt: new Date(Date.now() + 600000).toISOString(), messages: ["sudo loginctl enable-linger kyle"] });
  }); vi.stubGlobal("fetch", http); vi.stubEnv("CONTEXTLANES_URL", "http://127.0.0.1:4600");
  const generate = vi.spyOn(qr, "generate");
  const output = await setupOutput("192.0.2.42");
  expect(output).toContain(url); expect(output).toContain("Works once and expires in 10 minutes"); expect(output).toContain("sudo loginctl enable-linger kyle"); expect(output).not.toContain("private-shell-proof");
  expect(generate).toHaveBeenCalledWith(url, { small: true }, expect.any(Function)); expect(output).toMatch(/[█▀▄]/);
  expect(JSON.parse(String(http.mock.calls.at(-1)?.[1]?.body))).toEqual({ sshHost: "192.0.2.42" });
});

it("never sends the setup token to something that cannot prove it is the daemon", async () => {
  vi.resetModules();
  const { setupOutput: fresh } = await import("../src/setup.js");
  const root = await mkdtemp(join(tmpdir(), "cl-cli-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const controlFile = join(root, "setup-token"); await writeFile(controlFile, "private-shell-proof");
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (path, init) => {
    seen.push(JSON.stringify(init ?? {}));
    if (String(path).endsWith("/status")) return Response.json({ claimed: false, authorized: false, hasPasskey: false, hasLane: false, tailnetLogin: null, publicUrl: null, controlFile });
    return Response.json({ proof: "x".repeat(43) });
  })); vi.stubEnv("CONTEXTLANES_URL", "http://127.0.0.1:4600");
  await expect(fresh()).rejects.toThrow("Something other than ContextLanes");
  expect(seen.join("")).not.toContain("private-shell-proof");
});
it("adds the current folder by default and preserves an explicit ~ path for the daemon", async () => {
  const http = vi.fn<typeof fetch>(async () => Response.json({ id: "project", name: "Project" })); vi.stubGlobal("fetch", http);
  const body = () => JSON.parse(String(http.mock.calls.at(-1)?.[1]?.body));
  await addProject(); expect(body()).toEqual({ path: process.cwd() });
  await addProject("~/code/project"); expect(body()).toEqual({ path: "~/code/project" });
});
it("refuses to use remote HTTP as proof of shell access", async () => {
  vi.stubEnv("CONTEXTLANES_URL", "https://neo.test.ts.net"); await expect(setupOutput()).rejects.toThrow("SSH session");
});

it("explains that an older daemon must restart instead of hiding its incompatible status behind a generic error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ claimed: true, authorized: true, hasPasskey: false, tailnetLogin: null, publicUrl: "https://neo.test.ts.net" })));
  vi.stubEnv("CONTEXTLANES_URL", "http://127.0.0.1:4600");
  await expect(setupOutput()).rejects.toBeInstanceOf(ClientError);
  await expect(setupOutput()).rejects.toThrow("Restart the ContextLanes daemon, then run contextlanes setup again.");
});
