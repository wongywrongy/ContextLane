import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSpec, NotificationConfig, Passkey, LocalModel, AddProjectRequest, RoutingRule } from "@contextlanes/protocol";
import { parse, stringify } from "smol-toml";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";

/** Everything the setup wizard writes ends up in ~/.config/contextlanes/config.toml. */
export const Config = z.object({
  host: z.object({ name: z.string().default(hostname()) }).default({ name: hostname() }),
  listen: z.object({ host: z.literal("127.0.0.1").default("127.0.0.1"), port: z.number().int().min(1).max(65535).default(4600) }).default({ host: "127.0.0.1", port: 4600 }),
  paths: z
    .object({
      data: z.string().default(join(homedir(), ".local/share/contextlanes")),
      lanes: z.string().default(join(homedir(), "lanes")),
      /** Where Add repositories → GitHub clones to. */
      code: z.string().default(join(homedir(), "code")),
    })
    .default({ data: join(homedir(), ".local/share/contextlanes"), lanes: join(homedir(), "lanes"), code: join(homedir(), "code") }),
  access: z
    .object({
      /** Tailnet login allowed to use this machine. Null while unclaimed. */
      owner: z.string().nullable().default(null),
      passkey: Passkey.optional(),
      shellOwner: z.string().optional(),
    })
    .default({ owner: null }),
  agents: z.record(z.string(), AgentSpec).default({}),
  notifications: NotificationConfig.prefault({}),
  localModels: z.array(LocalModel).default([]),
  projects: z.array(AddProjectRequest).default([]),
  previews: z.object({
    mode: z.enum(["serve", "services", "caddy"]).default("serve"),
    /** HTTPS ports on the device for serve mode. */
    ports: z.object({ from: z.number().int().min(1).max(65535).default(4700), to: z.number().int().min(1).max(65535).default(4799) }).prefault({}),
    caddy: z.object({
      domain: z.string().regex(/^[a-z0-9.-]+$/),
      admin: z.url().refine((url) => ["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Caddy's admin API must stay on loopback").default("http://127.0.0.1:2019"),
      server: z.string().regex(/^[\w-]+$/).default("srv0"),
    }).optional(),
  }).refine((p) => p.mode !== "caddy" || p.caddy, "caddy mode needs [previews.caddy]").prefault({}),
  /** Browser for checkpoint screenshots; empty uses the one Playwright installed. */
  checker: z.object({ chromium: z.string().optional() }).prefault({}),
  routing: z.array(RoutingRule).default([]),
  /** The local helper (delegate): which local model, and the redo rate above which a kind turns itself off. */
  helper: z.object({ model: z.string().optional(), redoLimit: z.number().min(0).max(1).default(0.25) }).prefault({}),
  /** Open in editor: {host} is this machine's name, {path} the folder. Default: VS Code over Remote-SSH. */
  editor: z.object({ url: z.string().min(1).max(500).default("vscode://vscode-remote/ssh-remote+{host}{path}") }).prefault({}),
  /**
   * Per-lane Postgres databases: `admin` creates and drops copies (needs CREATEDB) and never leaves
   * the daemon; `app` is a non-admin login that owns each copy and is what lane services get.
   */
  databases: z.object({ postgres: z.object({ admin: z.string().regex(/^postgres(ql)?:\/\//), app: z.string().regex(/^postgres(ql)?:\/\//) }).optional() }).prefault({}),
  lanes: z.object({
    maxConcurrent: z.number().int().positive().default(6), launchHosts: z.boolean().default(true),
    host: AgentSpec.default({ command: process.execPath, args: [fileURLToPath(new URL("../../lanehost/dist/main.js", import.meta.url))] }),
    toolbox: AgentSpec.default({ command: process.execPath, args: [fileURLToPath(new URL("../../../packages/toolbox/dist/main.js", import.meta.url))] }),
  }).prefault({}),
});
export type Config = z.infer<typeof Config>;

export function configPath(): string {
  return process.env.CONTEXTLANES_CONFIG ?? join(homedir(), ".config/contextlanes/config.toml");
}

export function loadConfig(path = configPath()): Config {
  const raw = existsSync(path) ? parse(readFileSync(path, "utf8")) : {};
  return Config.parse(raw);
}

export async function saveConfig(config: Config, path = configPath()): Promise<void> {
  const validated = Config.parse(config);
  // TOML has no null; omit unset optional settings.
  const raw = JSON.parse(JSON.stringify(validated, (_key, value) => value === null ? undefined : value));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, stringify(raw), { mode: 0o600 });
  await rename(temporary, path);
}
