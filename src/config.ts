import { z } from 'zod';
import { readFile, stat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { id, link, Problem } from './shared/contracts.js';
const absolute = z
  .string()
  .max(4096)
  .refine((v) => !v.includes('\0') && !v.includes('\n'), 'Control characters are not allowed')
  .refine(isAbsolute, 'Must be an absolute path');
const origin = z.url().refine((v) => {
  const u = new URL(v);
  return u.protocol === 'https:' && u.origin === v;
}, 'Canonical HTTPS origin required');
const port = z.number().int().min(1024).max(65535);
const readiness = z.strictObject({
  path: z
    .string()
    .regex(/^\/(?!\/)[^\s#]*$/)
    .max(256),
  status: z.number().int().min(200).max(299).default(200),
  bodyIncludes: z.string().min(1).max(256),
  timeoutMs: z.number().int().min(100).max(60000).default(15000),
});
export const previewTargetSchema = z.strictObject({
  id,
  approved: z.literal(true),
  projectPath: absolute,
  checkoutPath: absolute,
  serviceId: id,
  serviceName: z.string().min(1).max(100),
  port,
  httpsPort: port,
  readiness,
});
export type PreviewTarget = z.infer<typeof previewTargetSchema>;
const service = z.strictObject({
  id,
  cwd: absolute,
  executable: absolute,
  args: z
    .array(
      z
        .string()
        .max(4096)
        .refine((v) => !v.includes('\0')),
    )
    .max(100),
  port,
  dependencies: z.array(id).max(16).default([]),
  readiness,
  envFile: absolute.optional(),
  env: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      z
        .string()
        .max(16384)
        .refine((v) => !v.includes('\0')),
    )
    .refine((env) => !Object.keys(env).some((k) => /(SECRET|TOKEN|KEY|PASSWORD)/i.test(k)), 'Secret variables belong in envFile')
    .optional(),
});
export const profileSchema = z.strictObject({
  id,
  projectPath: absolute,
  approved: z.literal(true),
  effects: z.string().min(1).max(1000),
  dataRequirements: z.string().min(1).max(1000),
  services: z.array(service).min(1).max(16),
  previews: z
    .array(z.strictObject({ serviceId: id, httpsPort: port, label: z.string().min(1).max(100) }))
    .min(1)
    .max(8),
});
export const configSchema = z.strictObject({
  projectRoots: z.array(absolute).min(1).max(16),
  observationRoots: z.array(absolute).min(1).max(32),
  stateDirectory: absolute,
  port: port.default(9480),
  telemetry: z.strictObject({
    enabled: z.boolean().default(false),
    port: port.default(9481),
    retentionDays: z.number().int().min(1).max(30).default(7),
  }).prefault({}),
  origin,
  additionalOrigins: z.array(origin).max(4).optional(),
  tailnetHostname: z.string().regex(/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/),
  previewTargets: z.array(previewTargetSchema).max(50).default([]),
  toolchains: z
    .strictObject({ node: absolute.optional(), python: absolute.optional(), venvs: z.record(z.string().max(4096), absolute).default({}) })
    .default({ venvs: {} }),
  instancePorts: z
    .tuple([port, port])
    .default([20000, 20999])
    .refine(([min, max]) => min <= max && max - min < 1000),
  // Accepted for older owner configs; recipes allocate from instancePorts.
  previewPortRange: z
    .tuple([port, port])
    .default([20000, 20999])
    .refine(([min, max]) => min <= max && max - min < 1000),
  editorUrlTemplate: z
    .string()
    .max(4096)
    .refine((value) => {
      try {
        const url = new URL(value.replaceAll('{host}', 'host').replaceAll('{path}', '/path'));
        return (
          ['vscode:', 'vscode-insiders:', 'cursor:', 'zed:', 'jetbrains:'].includes(url.protocol) &&
          !/[\r\n\0]/.test(value) &&
          !/\{(?!host\}|path\})/.test(value)
        );
      } catch {
        return false;
      }
    }, 'Use an approved editor scheme and {host}/{path} placeholders')
    .optional(),
  profiles: z.array(profileSchema).max(50).default([]),
  projects: z
    .array(
      z.strictObject({
        path: absolute,
        links: z.array(link).max(20).default([]),
        agents: z
          .array(z.strictObject({ name: z.string().min(1).max(100) }))
          .max(20)
          .default([]),
      }),
    )
    .max(200)
    .default([]),
});
export type Config = z.infer<typeof configSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type Service = Profile['services'][number];
export function inside(path: string, root: string) {
  const r = relative(root, path);
  return r === '' || (r !== '..' && !r.startsWith('../') && !isAbsolute(r));
}
export function revision(profile: Profile | PreviewTarget) {
  return createHash('sha256').update(JSON.stringify(profile)).digest('hex');
}
export async function privateFile(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077)
    throw new Problem('PRIVATE_FILE_REQUIRED', `${path} must be owned by this user with mode 0600`);
  if (info.size > 256 * 1024) throw new Problem('CONFIG_TOO_LARGE', 'Owner configuration exceeds 256 KiB');
  return readFile(path, 'utf8');
}
export async function loadConfig(path: string): Promise<Config> {
  const config = configSchema.parse(JSON.parse(await privateFile(path)));
  config.projectRoots = await Promise.all(config.projectRoots.map((p) => realpath(p)));
  config.observationRoots = await Promise.all(config.observationRoots.map((p) => realpath(p)));
  const configPath = await realpath(path);
  if (config.observationRoots.some((root) => inside(configPath, root)))
    throw new Problem('CONFIG_LOCATION', 'Keep owner configuration outside observation roots');
  if (new URL(config.origin).hostname !== config.tailnetHostname || Number(new URL(config.origin).port || 443) === config.port)
    throw new Problem('INVALID_CONFIG', 'Rootlane HTTPS origin must use the configured tailnet hostname and a separate port');
  if (!config.projectRoots.every((root) => config.observationRoots.some((observed) => inside(root, observed))))
    throw new Problem('INVALID_CONFIG', 'Project roots must be within observation roots');
  for (const entry of config.projects) {
    entry.path = await realpath(entry.path);
    if (!config.observationRoots.some((r) => inside(entry.path, r))) throw new Problem('INVALID_CONFIG', 'Project outside observation roots');
  }
  const seen = new Set<string>();
  for (const profile of config.profiles) {
    if (seen.has(profile.id)) throw new Problem('INVALID_PROFILE', `Duplicate profile ${profile.id}`);
    seen.add(profile.id);
    profile.projectPath = await realpath(profile.projectPath);
    if (!config.observationRoots.some((r) => inside(profile.projectPath, r)))
      throw new Problem('INVALID_PROFILE', 'Profile outside observation roots');
    const services = new Set<string>();
    const ports = new Set<number>();
    for (const svc of profile.services) {
      svc.cwd = await realpath(svc.cwd);
      if (!inside(svc.cwd, profile.projectPath) || services.has(svc.id) || ports.has(svc.port))
        throw new Problem('INVALID_PROFILE', `Invalid cwd, duplicate service or port in ${profile.id}`);
      if (svc.envFile) {
        svc.envFile = await realpath(svc.envFile);
        if (config.observationRoots.some((root) => inside(svc.envFile!, root)))
          throw new Problem('PRIVATE_FILE_REQUIRED', 'envFile must be outside observation roots');
        await privateFile(svc.envFile);
      }
      services.add(svc.id);
      ports.add(svc.port);
    }
    if (ports.has(config.port) || ports.has(config.telemetry.port) || ports.has(Number(new URL(config.origin).port || 443)))
      throw new Problem('INVALID_PROFILE', 'Application port conflicts with Rootlane');
    orderedServices(profile);
    const routes = new Set<number>();
    for (const route of profile.previews) {
      if (
        !services.has(route.serviceId) ||
        routes.has(route.httpsPort) ||
        ports.has(route.httpsPort) ||
        route.httpsPort === config.port ||
        route.httpsPort === config.telemetry.port ||
        route.httpsPort === Number(new URL(config.origin).port || 443)
      )
        throw new Problem('INVALID_PROFILE', 'Invalid or reserved preview port');
      routes.add(route.httpsPort);
    }
  }
  const reserved = new Set([config.port, config.telemetry.port, ...[config.origin, ...(config.additionalOrigins ?? [])].map((o) => Number(new URL(o).port || 443))]);
  const ids = new Set<string>();
  const routes = new Set<number>();
  const appPorts = new Set([...config.profiles.flatMap((p) => p.services.map((s) => s.port)), ...config.previewTargets.map((t) => t.port)]);
  for (const target of config.previewTargets) {
    target.projectPath = await realpath(target.projectPath);
    target.checkoutPath = await realpath(target.checkoutPath);
    if (![target.projectPath, target.checkoutPath].every((p) => config.observationRoots.some((r) => inside(p, r))))
      throw new Problem('INVALID_TARGET', 'Preview paths must be within observation roots');
    if (
      ids.has(target.id) ||
      routes.has(target.httpsPort) ||
      reserved.has(target.port) ||
      reserved.has(target.httpsPort) ||
      appPorts.has(target.httpsPort) ||
      config.profiles.some((p) => p.previews.some((r) => r.httpsPort === target.httpsPort))
    )
      throw new Problem('INVALID_TARGET', 'Duplicate target or reserved preview/application port');
    ids.add(target.id);
    routes.add(target.httpsPort);
  }
  return config;
}
export function orderedServices(profile: Profile): Service[] {
  const result: Service[] = [];
  const pending = new Map(profile.services.map((s) => [s.id, s]));
  while (pending.size) {
    const next = [...pending.values()].find((s) => s.dependencies.every((d) => result.some((r) => r.id === d)));
    if (!next) throw new Problem('INVALID_PROFILE', 'Missing dependency or dependency cycle');
    result.push(next);
    pending.delete(next.id);
  }
  return result;
}
