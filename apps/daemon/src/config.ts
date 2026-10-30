import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSpec, NotificationConfig, Passkey, LocalModel, AddProjectRequest } from "@contextlanes/protocol";
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
    })
    .default({ data: join(homedir(), ".local/share/contextlanes"), lanes: join(homedir(), "lanes") }),
  access: z
    .object({
      /** Tailnet login allowed to use this machine. Null while unclaimed. */
      owner: z.string().nullable().default(null),
      /** Accept requests without identity headers from loopback (development, CLI on the box). */
      allowLocal: z.boolean().default(true),
      passkey: Passkey.optional(),
      shellOwner: z.string().optional(),
    })
    .default({ owner: null, allowLocal: true }),
  agents: z.record(z.string(), AgentSpec).default({}),
  notifications: NotificationConfig.prefault({}),
  localModels: z.array(LocalModel).default([]),
  projects: z.array(AddProjectRequest).default([]),
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
