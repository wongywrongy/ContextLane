import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSpec, NotificationConfig, Passkey, LocalModel, AddProjectRequest, RoutingRule, Schedule } from "@contextlanes/protocol";
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
  previews: z.preprocess(migratePreviews, z.object({
    /**
     * router: one port answers `<label>.<domain>` and `<label>.localhost`; put one wildcard entry for the
     * domain in your own reverse proxy. serve: a Tailscale Serve HTTPS port per service.
     */
    mode: z.enum(["router", "serve"]).default("router"),
    /** The wildcard name your proxy sends here, e.g. root.example.dev for *.root.example.dev. */
    domain: z.string().regex(/^(?=.{1,200}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/, "a lowercase DNS name such as root.example.dev").optional(),
    /** How browsers reach the domain. Your proxy terminates TLS, so this is almost always https. */
    scheme: z.enum(["https", "http"]).optional(),
    /** 0 picks any free port (tests). */
    localPort: z.number().int().min(0).max(65535).default(4601),
    /** Where the router listens. Only this port may leave loopback; the API never does. */
    bind: z.union([z.ipv4(), z.ipv6()]).default("127.0.0.1"),
    /** Reserved label for the web app itself: https://lanes.<domain>. */
    appLabel: z.string().regex(/^[a-z][a-z0-9]{0,30}$/).default("lanes"),
    /** HTTPS ports on the device for serve mode. */
    ports: z.object({ from: z.number().int().min(1).max(65535).default(4700), to: z.number().int().min(1).max(65535).default(4799) }).prefault({}),
  })).prefault({}),
  /** Browser for checkpoint screenshots; empty uses the one Playwright installed. */
  checker: z.object({ chromium: z.string().optional() }).prefault({}),
  routing: z.array(RoutingRule).default([]),
  schedules: z.array(Schedule).default([]),
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

/**
 * Earlier releases had local, services and caddy modes. local is the router without a domain; services
 * and caddy become the router, keeping a Caddy domain so links keep their names behind the owner's proxy.
 */
function migratePreviews(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const { mode, caddy, ...rest } = raw as { mode?: unknown; caddy?: { domain?: unknown } } & Record<string, unknown>;
  if (mode === "local" || mode === "services" || mode === "caddy") {
    const domain = mode === "caddy" && typeof caddy?.domain === "string" && rest.domain === undefined ? { domain: caddy.domain } : {};
    return { ...rest, ...domain, mode: "router" };
  }
  return mode === undefined ? rest : { ...rest, mode };
}

export function configPath(): string {
  return process.env.CONTEXTLANES_CONFIG ?? join(homedir(), ".config/contextlanes/config.toml");
}

/**
 * The lane host and toolbox always run from the release that is running now. A config saved by an
 * earlier version wrote their paths out (pointing at the first install's checkout), which left new
 * lanes on old code after every update; such paths are dropped on load and never written again.
 */
const OURS = [/\/apps\/lanehost\/dist\/main\.js$/, /\/packages\/toolbox\/dist\/main\.js$/];
function withoutBuiltInPaths(raw: Record<string, unknown>): Record<string, unknown> {
  const lanes = raw.lanes as Record<string, { args?: unknown }> | undefined;
  if (!lanes) return raw;
  const next = { ...lanes };
  for (const key of ["host", "toolbox"]) {
    const args = next[key]?.args;
    if (Array.isArray(args) && typeof args[0] === "string" && OURS.some((re) => re.test(args[0] as string))) delete next[key];
  }
  return { ...raw, lanes: next };
}

export function loadConfig(path = configPath()): Config {
  const raw = existsSync(path) ? parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
  return Config.parse(withoutBuiltInPaths(raw));
}

export async function saveConfig(config: Config, path = configPath()): Promise<void> {
  const validated = Config.parse(config);
  // TOML has no null; omit unset optional settings.
  const raw = withoutBuiltInPaths(JSON.parse(JSON.stringify(validated, (_key, value) => value === null ? undefined : value)));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, stringify(raw), { mode: 0o600 });
  await rename(temporary, path);
}
