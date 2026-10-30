import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand, type Runner } from "@contextlanes/daemon";
import { AgentRegistry } from "../src/registry.js";

const roots: string[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });

// Entries as they appear in github.com/agentclientprotocol/registry (gemini/agent.json, goose/agent.json).
const registry = (tarball: Buffer) => ({ version: "1.0.0", agents: [
  { id: "gemini", name: "Gemini CLI", version: "0.66.0", description: "Google's official CLI for Gemini", license: "Apache-2.0", distribution: { npx: { package: "@google/gemini-cli@0.66.0", args: ["--acp"] } } },
  { id: "goose", name: "goose", version: "1.57.0", description: "A local AI agent", distribution: { binary: { [`linux-${process.arch === "arm64" ? "aarch64" : "x86_64"}`]: { archive: "https://example.invalid/goose.tar.bz2", cmd: "./goose", args: ["acp"], sha256: createHash("sha256").update(tarball).digest("hex") } } } },
  { id: "codex-acp", name: "Codex", version: "2.5.0", distribution: { npx: { package: "@agentclientprotocol/codex-acp@2.5.0" } } },
  { id: "risky", name: "Risky", version: "1.0.0", distribution: { npx: { package: "risky@1.0.0", args: ["--acp", "--permission-mode", "bypassPermissions"] } } },
  { id: "risky-env", name: "Risky env", version: "1.0.0", distribution: { npx: { package: "risky-env@1.0.0", env: { CODEX_APPROVAL_POLICY: "never" } } } },
  { id: "broken" },
] });

describe("ACP registry", () => {
  it("lists agents it can install here, leaving out the built-in ones and malformed entries", async () => {
    const fetch = (async () => Response.json(registry(Buffer.from("x")))) as unknown as typeof globalThis.fetch;
    const list = await new AgentRegistry({ run: async () => ({ stdout: "" }), fetch }).list({ gemini: {} });
    expect(list.map((a) => [a.id, a.install, a.installed])).toEqual([["gemini", "npm", true], ["goose", "download", false], ["risky", "npm", false], ["risky-env", "npm", false]]);
  });

  it("installs an npm agent and a checked download, refusing entries that turn off permission prompts", async () => {
    const home = await mkdtemp(join(tmpdir(), "cl-reg-")); roots.push(home);
    const src = join(home, "src"); await mkdir(src); await writeFile(join(src, "goose"), "#!/bin/sh\n", { mode: 0o755 });
    await runCommand("tar", ["-cjf", join(home, "goose.tar.bz2"), "-C", src, "goose"]);
    const { readFile } = await import("node:fs/promises");
    const tarball = await readFile(join(home, "goose.tar.bz2"));
    const fetch = (async (url: string) => String(url).endsWith(".tar.bz2") ? new Response(tarball) : Response.json(registry(tarball))) as unknown as typeof globalThis.fetch;
    const run: Runner = async (cmd, args, opts) => {
      if (cmd === "npm") { const dir = join(home, ".local/lib/node_modules/@google/gemini-cli"); await mkdir(dir, { recursive: true }); await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@google/gemini-cli", bin: { gemini: "dist/index.js" } })); return { stdout: "" }; }
      return runCommand(cmd, args, opts);
    };
    const reg = new AgentRegistry({ run, fetch, home });
    expect(await reg.install("gemini")).toEqual({ command: join(home, ".local/bin/gemini"), args: ["--acp"] });
    const goose = await reg.install("goose");
    expect(goose).toEqual({ command: join(home, ".local/share/acp-agents/goose/1.57.0/goose"), args: ["acp"] });
    const bad = (async (url: string) => String(url).endsWith(".tar.bz2") ? new Response("tampered") : Response.json(registry(tarball))) as unknown as typeof globalThis.fetch;
    await expect(reg.install("risky")).rejects.toThrow(/--permission-mode.*not installed/);
    await expect(reg.install("risky-env")).rejects.toThrow(/CODEX_APPROVAL_POLICY/);
    await expect(new AgentRegistry({ run, fetch: bad, home }).install("goose")).rejects.toThrow(/did not match the registry's checksum/);
  });
});
