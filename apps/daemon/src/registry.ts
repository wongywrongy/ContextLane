import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RegistryAgent } from "@contextlanes/protocol";
import { Refused } from "./lanes/manager.js";
import type { Runner } from "./run.js";
import { findExecutable } from "./setup.js";

/** The ACP registry (agentclientprotocol.com/registry): agents that speak ACP, with how to install each. */
export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const Target = z.object({ archive: z.url(), sha256: z.string().regex(/^[a-f0-9]{64}$/), cmd: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).optional() });
const Entry = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,60}$/), name: z.string(), version: z.string(), description: z.string().default(""), website: z.string().optional(), license: z.string().optional(),
  distribution: z.object({
    npx: z.object({ package: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).optional() }).optional(),
    uvx: z.object({ package: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).optional() }).optional(),
    binary: z.record(z.string(), Target).optional(),
  }),
});
const Registry = z.object({ agents: z.array(z.unknown()) });
/** The three agents ContextLanes sets up itself, with their own sign-in flows. */
const BUILT_IN = new Set(["claude-acp", "codex-acp", "opencode", "opencode-v2"]);
const PLATFORM = `linux-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
/** Approval-bypassing switches some agents take; never passed, whatever the registry says. */
const UNSAFE = /^--?(yolo|dangerously|bypass|full-auto|auto-approve|approval-policy=never)/i;

/** Installs registry agents beside the user's other tools (not in the data folder, which lanes cannot see). */
export class AgentRegistry {
  constructor(private deps: { run: Runner; fetch?: typeof fetch; home?: string; url?: string; find?: (name: string) => Promise<string | null> }) {}
  private home() { return this.deps.home ?? homedir(); }

  async list(installed: Record<string, unknown>): Promise<RegistryAgent[]> {
    const res = await (this.deps.fetch ?? fetch)(this.deps.url ?? REGISTRY_URL, { signal: AbortSignal.timeout(15_000), redirect: "follow" })
      .catch(() => { throw new Refused("The ACP registry could not be reached from this machine."); });
    if (!res.ok) throw new Refused(`The ACP registry answered ${res.status}.`);
    const entries = Registry.parse(await res.json()).agents.flatMap((a) => { const e = Entry.safeParse(a); return e.success ? [e.data] : []; });
    return entries.filter((e) => !BUILT_IN.has(e.id)).map((e) => {
      const how: RegistryAgent["install"] = e.distribution.npx ? "npm" : e.distribution.binary?.[PLATFORM] ? "download" : e.distribution.uvx ? "uv" : null;
      return { id: e.id, name: e.name, version: e.version, description: e.description, website: e.website ?? null, license: e.license ?? null, install: how, installed: e.id in installed };
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Installs one agent and returns the [agents.<id>] spec to save in config. */
  async install(agentId: string): Promise<{ command: string; args: string[]; env?: Record<string, string> }> {
    const res = await (this.deps.fetch ?? fetch)(this.deps.url ?? REGISTRY_URL, { signal: AbortSignal.timeout(15_000) }).catch(() => { throw new Refused("The ACP registry could not be reached from this machine."); });
    const entry = Registry.parse(await res.json()).agents.map((a) => Entry.safeParse(a)).find((e) => e.success && e.data.id === agentId);
    if (!entry?.success) throw new Refused(`There is no agent ${agentId} in the ACP registry.`);
    const e = entry.data;
    const safe = (args: string[]) => args.filter((a) => !UNSAFE.test(a));
    if (e.distribution.npx) {
      const { package: pkg, args, env } = e.distribution.npx;
      const prefix = join(this.home(), ".local");
      await this.deps.run("npm", ["install", "--global", "--prefix", prefix, pkg], { timeout: 300_000 }).catch(() => { throw new Refused(`${e.name} could not be installed with npm; check this machine's connection to the npm registry.`); });
      const name = pkg.replace(/@[^@/]+$/, "");
      const manifest = JSON.parse(await readFile(join(prefix, "lib", "node_modules", name, "package.json"), "utf8")) as { bin?: string | Record<string, string>; name: string };
      const bin = typeof manifest.bin === "string" ? manifest.name.split("/").at(-1)! : Object.keys(manifest.bin ?? {})[0];
      if (!bin) throw new Refused(`${e.name}'s package has no command to run.`);
      return { command: join(prefix, "bin", bin), args: safe(args), ...(env ? { env } : {}) };
    }
    const target = e.distribution.binary?.[PLATFORM];
    if (target) {
      const dir = join(this.home(), ".local", "share", "acp-agents", e.id, e.version);
      const archive = await (this.deps.fetch ?? fetch)(target.archive, { signal: AbortSignal.timeout(600_000) }).then(async (r) => r.ok ? Buffer.from(await r.arrayBuffer()) : null, () => null);
      if (!archive) throw new Refused(`${e.name} could not be downloaded.`);
      if (createHash("sha256").update(archive).digest("hex") !== target.sha256) throw new Refused(`${e.name}'s download did not match the registry's checksum, so it was not installed.`);
      await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
      const file = join(dir, target.archive.split("/").at(-1)!);
      await writeFile(file, archive);
      if (file.endsWith(".zip")) await this.deps.run("unzip", ["-q", file, "-d", dir]);
      else await this.deps.run("tar", ["-xf", file, "-C", dir]);
      await rm(file, { force: true });
      return { command: join(dir, target.cmd), args: safe(target.args), ...(target.env ? { env: target.env } : {}) };
    }
    if (e.distribution.uvx) {
      const uvx = await (this.deps.find ?? findExecutable)("uvx");
      if (!uvx) throw new Refused(`${e.name} runs with uv. Install uv, then try again.`);
      return { command: uvx, args: [e.distribution.uvx.package, ...safe(e.distribution.uvx.args)], ...(e.distribution.uvx.env ? { env: e.distribution.uvx.env } : {}) };
    }
    throw new Refused(`${e.name} has no build for this machine (${PLATFORM}).`);
  }
}
