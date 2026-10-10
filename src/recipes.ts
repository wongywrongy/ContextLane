import { z } from 'zod';
import { open, realpath, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { inside, orderedServices, profileSchema, revision, type Profile } from './config.js';
import { command } from './host/command.js';
import { Problem, id } from './shared/contracts.js';
import type { Rootlane } from './service.js';
const text = z
  .string()
  .max(4096)
  .refine((v) => !/[\0\r\n]/.test(v), 'Control characters are forbidden');
const wrappers = new Set(['env', 'sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell']);
const readiness = z.strictObject({
  path: z
    .string()
    .regex(/^\/(?!\/)[^\s#]*$/)
    .max(256),
  status: z.number().int().min(200).max(299).default(200),
  bodyIncludes: z.string().min(1).max(256),
  timeoutMs: z.number().int().min(100).max(60000).default(15000),
});
export const recipeSchema = z
  .strictObject({
    version: z.literal(1),
    services: z
      .array(
        z.strictObject({
          id,
          cwd: text.default('.').refine((p) => !isAbsolute(p) && !p.split(/[\\/]/).includes('..'), 'cwd must stay within the checkout'),
          command: z
            .array(text.min(1))
            .min(1)
            .max(100)
            .refine((a) => !wrappers.has(basename(a[0]!)), 'Shell and env wrappers are forbidden'),
          env: z
            .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), text)
            .default({})
            .refine((e) => !Object.keys(e).some((k) => /(SECRET|TOKEN|KEY|PASSWORD)/i.test(k)), 'Secret variable names belong in envFile')
            .refine((e) => !Object.keys(e).some((k) => k.startsWith('ROOTLANE_')), 'ROOTLANE_ variables are reserved'),
          envFile: text.optional(),
          dependencies: z.array(id).max(16).default([]),
          readiness,
        }),
      )
      .min(1)
      .max(16),
    previews: z
      .array(z.strictObject({ serviceId: id, label: text.min(1).max(100) }))
      .min(1)
      .max(8),
    setup: z.array(text).max(20).default([]),
  })
  .superRefine((r, ctx) => {
    const ids = new Set(r.services.map((s) => s.id)),
      previews = new Set(r.previews.map((p) => p.serviceId));
    if (ids.size !== r.services.length || previews.size !== r.previews.length || r.previews.some((p) => !ids.has(p.serviceId)))
      ctx.addIssue({ code: 'custom', message: 'Duplicate or unknown service/preview' });
    const done = new Set<string>();
    for (let i = 0; i < r.services.length; i++) {
      const s = r.services.find((s) => !done.has(s.id) && s.dependencies.every((d) => done.has(d)));
      if (!s) {
        ctx.addIssue({ code: 'custom', message: 'Missing dependency or cycle' });
        break;
      }
      done.add(s.id);
    }
    for (const s of r.services)
      for (const v of [...s.command, ...Object.values(s.env), ...(s.envFile ? [s.envFile] : [])]) {
        for (const match of v.matchAll(/\{([^{}]*)\}/g)) {
          const key = match[1]!;
          if (
            !['state', 'node', 'python', 'venv'].includes(key) &&
            !(key.startsWith('port:') && ids.has(key.slice(5))) &&
            !(key.startsWith('preview:') && previews.has(key.slice(8)))
          )
            ctx.addIssue({ code: 'custom', path: ['services', s.id], message: 'Unknown placeholder' });
        }
        if (/[{}]/.test(v.replace(/\{[^{}]*\}/g, ''))) ctx.addIssue({ code: 'custom', message: 'Malformed placeholder' });
      }
  });
export type Recipe = z.infer<typeof recipeSchema>;
type Allocations = {
  ports: Record<string, number>;
  previews: Record<string, number>;
};
type Instance = {
  id: string;
  projectPath: string;
  checkoutPath: string;
  approvalId: string;
  allocations: string;
};
type Approval = {
  id: string;
  projectPath: string;
  recipeHash: string;
  toolchainRevision: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  preview: string;
};
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const slug = (path: string) =>
  `${
    basename(path)
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 24) || 'checkout'
  }-${hash(path).slice(0, 6)}`;
async function boundedFile(path: string, limit: number, privateOwner = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Problem('RECIPE_INVALID', 'File is not regular or exceeds the size limit');
    if (privateOwner && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600))
      throw new Problem('PRIVATE_FILE_REQUIRED', 'envFile must be owner-owned with mode 0600');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Problem('RECIPE_INVALID', 'File exceeds size limit');
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
export class Recipes {
  readonly profiles = new Map<string, Profile>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly service: Rootlane) {}
  get db() {
    return this.service.lifecycle.store.db;
  }
  instances(checkout?: string) {
    return this.db
      .prepare(`SELECT * FROM instances ${checkout ? 'WHERE checkoutPath=?' : ''} ORDER BY id LIMIT 100`)
      .all(...(checkout ? [checkout] : [])) as Instance[];
  }
  approval(id: string) {
    return this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as Approval | undefined;
  }
  private async context(path: string, checkoutHint = false, knownCommonDir?: string) {
    const { config } = this.service.lifecycle;
    const actual = await realpath(path).catch(() => null);
    if (!actual || !config.observationRoots.some((r) => inside(actual, r))) throw new Problem('NOT_FOUND', 'Path is outside observation roots');
    const early = checkoutHint ? await boundedFile(join(actual, '.rootlane.json'), 65536) : null;
    const [checkout, commonPath] = knownCommonDir
      ? [actual, knownCommonDir]
      : (
          await command('git', ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'], {
            cwd: actual,
            timeout: 1000,
            maxBuffer: 4096,
          })
        )
          .trim()
          .split('\n');
    if (!checkout || !commonPath) throw new Problem('RECIPE_INVALID', 'A Git checkout is required');
    const common = await realpath(commonPath);
    if (!config.observationRoots.some((r) => inside(checkout, r)) || !config.observationRoots.some((r) => inside(common, r)))
      throw new Problem('NOT_FOUND', 'Checkout or git common directory is outside observation roots');
    const data = early && actual === checkout ? early : await boundedFile(join(checkout, '.rootlane.json'), 65536);
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString('utf8'));
    } catch {
      throw new Problem('RECIPE_INVALID', 'Recipe must be valid JSON');
    }
    const parsed = recipeSchema.safeParse(raw);
    if (!parsed.success) throw new Problem('RECIPE_INVALID', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const recipe = parsed.data,
      tools: Record<string, string> = {},
      configuredTools: Record<string, string> = {};
    const values = recipe.services.flatMap((s) => [...s.command, ...Object.values(s.env), ...(s.envFile ? [s.envFile] : [])]);
    for (const key of ['node', 'python', 'venv'] as const)
      if (values.some((v) => v.includes(`{${key}}`))) {
        const configured =
          key === 'venv' ? (config.toolchains.venvs[common] ?? config.toolchains.venvs[basename(dirname(common))]) : config.toolchains[key];
        if (!configured) throw new Problem('TOOLCHAIN_MISSING', `Missing toolchain key: ${key}`);
        configuredTools[key] = configured;
        tools[key] = await realpath(configured).catch(() => {
          throw new Problem('TOOLCHAIN_MISSING', `Toolchain path unavailable: ${key}`);
        });
      }
    return {
      checkout,
      common,
      recipe,
      recipeHash: hash(data),
      tools,
      toolchainRevision: hash(JSON.stringify({ configured: configuredTools, resolved: tools })),
      instanceId: `${slug(dirname(common))}-${slug(checkout)}`,
    };
  }
  async inspect(path: string, knownCommonDir?: string) {
    try {
      const c = await this.context(path, true, knownCommonDir);
      const matching = this.db
        .prepare('SELECT * FROM approvals WHERE projectPath=? AND recipeHash=? AND toolchainRevision=?')
        .get(c.common, c.recipeHash, c.toolchainRevision) as Approval | undefined;
      const prior = this.db.prepare('SELECT id FROM approvals WHERE projectPath=? LIMIT 1').get(c.common);
      return {
        found: true,
        valid: true,
        errors: [] as {
          code: string;
          message: string;
        }[],
        approval:
          matching?.status === 'approved'
            ? ('approved' as const)
            : matching?.status === 'pending'
              ? ('pending' as const)
              : matching?.status === 'rejected'
                ? ('none' as const)
                : prior
                  ? ('stale' as const)
                  : ('none' as const),
        ...(matching ? { approvalId: matching.id, approvalUrl: this.url(matching.id) } : {}),
      };
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      const old = this.instances(path)[0];
      return {
        found: !missing,
        valid: false,
        errors: missing
          ? []
          : [error instanceof Problem ? { code: error.code, message: error.message } : { code: 'RECIPE_INVALID', message: 'Recipe is unavailable' }],
        approval: old ? ('stale' as const) : ('none' as const),
        ...(old ? { approvalId: old.approvalId, approvalUrl: this.url(old.approvalId) } : {}),
      };
    }
  }
  url(id: string) {
    return `${this.service.lifecycle.config.origin}/?approval=${id}`;
  }
  private async resolve(c: Awaited<ReturnType<Recipes['context']>>, instance: Instance, launch = false) {
    const { config } = this.service.lifecycle,
      a = JSON.parse(instance.allocations) as Allocations;
    const state = join(config.stateDirectory, 'instances', instance.id),
      ownerHome = process.env.ROOTLANE_OWNER_HOME || homedir();
    const expand = (value: string) =>
      value
        .replace(/^~(?=\/|$)/, ownerHome)
        .replace(/\{([^{}]+)\}/g, (_, key: string) =>
          key === 'state'
            ? state
            : key.startsWith('port:')
              ? String(a.ports[key.slice(5)])
              : key.startsWith('preview:')
                ? `https://${config.tailnetHostname}:${a.previews[key.slice(8)]}`
                : c.tools[key]!,
        );
    const services = [];
    const secrets: string[] = [];
    const envNames = new Map<string, string[]>();
    for (const s of c.recipe.services) {
      const cwd = await realpath(join(c.checkout, s.cwd));
      if (!inside(cwd, c.checkout)) throw new Problem('RECIPE_INVALID', 'Service cwd resolves outside the checkout');
      const cmd = s.command.map(expand);
      const executable = await realpath(isAbsolute(cmd[0]!) ? cmd[0]! : join(c.checkout, cmd[0]!));
      if (wrappers.has(basename(executable))) throw new Problem('RECIPE_INVALID', 'Resolved shell/env wrappers are forbidden');
      let fromFile: Record<string, string> = {};
      let envFile: string | undefined;
      if (s.envFile) {
        const file = await realpath(expand(s.envFile));
        envFile = file;
        if (config.observationRoots.some((root) => inside(file, root)))
          throw new Problem('PRIVATE_FILE_REQUIRED', 'envFile must be outside observation roots');
        fromFile = z
          .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
          .parse(parseEnv((await boundedFile(file, 65536, true)).toString('utf8')));
        if (Object.keys(fromFile).length > 100 || Object.keys(fromFile).some((k) => k.startsWith('ROOTLANE_')))
          throw new Problem('RECIPE_INVALID', 'Invalid or reserved envFile variable names');
      }
      const https = a.previews[s.id];
      secrets.push(...Object.values(fromFile));
      envNames.set(s.id, Object.keys(fromFile));
      const env = {
        ...Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, expand(v)])),
        ROOTLANE_PORT: String(a.ports[s.id]),
        ROOTLANE_PREVIEW_ORIGIN: https ? `https://${config.tailnetHostname}:${https}` : '',
        ROOTLANE_PREVIEW_PORT: https ? String(https) : '',
      };
      if (
        [...Object.values(env), ...Object.values(fromFile)].some((v) => v.includes('\0') || v.length > 16384) ||
        JSON.stringify({ ...fromFile, ...env }).length > 65536
      )
        throw new Problem('RECIPE_INVALID', 'Environment exceeds allowed bounds');
      services.push({
        id: s.id,
        cwd,
        executable,
        args: cmd.slice(1),
        port: a.ports[s.id]!,
        dependencies: s.dependencies,
        readiness: s.readiness,
        env,
        ...(envFile ? { envFile } : {}),
      });
    }
    const profile = profileSchema.parse({
      id: instance.id,
      approved: true,
      projectPath: c.checkout,
      effects: 'Starts the owner-approved recipe services and private previews.',
      dataRequirements: 'As reviewed in the project recipe and setup hints.',
      services,
      previews: c.recipe.previews.map((p) => ({ ...p, httpsPort: a.previews[p.serviceId] })),
    });
    orderedServices(profile);
    if (launch) {
      await mkdir(state, { recursive: true, mode: 0o700 });
      const actual = await realpath(state);
      const info = await stat(actual);
      if (!inside(actual, await realpath(config.stateDirectory)) || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        throw new Problem('PRIVATE_FILE_REQUIRED', 'Instance state resolves outside Rootlane state');
      this.service.lifecycle.store.saveRedactions(instance.id, [...secrets, ...services.flatMap((s) => Object.values(s.env))]);
    }
    const resolvedPreview = {
      instanceId: instance.id,
      projectPath: c.common,
      checkoutPath: c.checkout,
      recipeHash: c.recipeHash,
      toolchainRevision: c.toolchainRevision,
      services: services.map((s) => ({
        id: s.id,
        command: [s.executable, ...s.args],
        cwd: s.cwd,
        envNames: [...new Set([...Object.keys(s.env), ...(envNames.get(s.id) ?? [])])].sort(),
        port: s.port,
        readiness: s.readiness,
      })),
      previews: profile.previews.map((p) => ({
        serviceId: p.serviceId,
        label: p.label,
        port: p.httpsPort,
        url: `https://${config.tailnetHostname}:${p.httpsPort}/`,
      })),
      setup: c.recipe.setup,
    };
    return { profile, resolvedPreview };
  }
  request(path: string, requestId: string) {
    const task = this.queue.then(() => this.requestUnlocked(path, requestId));
    this.queue = task.catch(() => {});
    return task;
  }
  private async requestUnlocked(path: string, requestId: string) {
    const c = await this.context(path),
      { config, host, store } = this.service.lifecycle;
    if (this.db.prepare('SELECT id FROM requests WHERE id=?').get(requestId))
      throw new Problem('REQUEST_ID_REUSED', 'requestId belongs to another action');
    const retry = this.db.prepare('SELECT * FROM recipe_requests WHERE id=?').get(requestId) as
      | {
          path: string;
          instanceId: string;
          recipeHash: string;
          toolchainRevision: string;
        }
      | undefined;
    if (retry && retry.path !== c.checkout) throw new Problem('REQUEST_ID_REUSED', 'requestId belongs to another checkout');
    if (retry && (retry.recipeHash !== c.recipeHash || retry.toolchainRevision !== c.toolchainRevision))
      throw new Problem('REQUEST_ID_REUSED', 'Recipe changed; use a new requestId for the new review');
    let instance = this.instances().find((i) => i.id === c.instanceId);
    if (
      config.profiles.some((p) => p.id === c.instanceId) ||
      (instance && (instance.checkoutPath !== c.checkout || instance.projectPath !== c.common))
    )
      throw new Problem('INSTANCE_CONFLICT', 'Instance ID conflicts with a configured profile or another checkout');
    if (
      instance &&
      store.resources(instance.id).length &&
      (this.approval(instance.approvalId)?.recipeHash !== c.recipeHash ||
        this.approval(instance.approvalId)?.toolchainRevision !== c.toolchainRevision)
    )
      throw new Problem('NEEDS_STOP', 'Stop this instance before replacing its recipe');
    const matching = this.db
      .prepare('SELECT * FROM approvals WHERE projectPath=? AND recipeHash=? AND toolchainRevision=?')
      .get(c.common, c.recipeHash, c.toolchainRevision) as Approval | undefined;
    if (matching?.status === 'rejected') throw new Problem('APPROVAL_REJECTED', `The owner rejected this recipe; review ${this.url(matching.id)}`);
    const listeners = await host.listeners(),
      routes = await host.routes(),
      reserved = new Set([
        config.port,
        ...[config.origin, ...(config.additionalOrigins ?? [])].map((u) => Number(new URL(u).port || 443)),
        ...listeners.map((l) => l.port),
        ...config.profiles.flatMap((p) => [...p.services.map((s) => s.port), ...p.previews.map((p) => p.httpsPort)]),
        ...config.previewTargets.flatMap((t) => [t.port, t.httpsPort]),
      ]);
    this.db
      .transaction(() => {
        if (
          !instance ||
          this.approval(instance.approvalId)?.recipeHash !== c.recipeHash ||
          this.approval(instance.approvalId)?.toolchainRevision !== c.toolchainRevision
        ) {
          if (!instance && this.instances().length >= 100) throw new Problem('INSTANCE_LIMIT', 'At most 100 recipe instances');
          const allocations: Allocations = { ports: Object.create(null), previews: Object.create(null) };
          const free = () => {
            for (let port = config.instancePorts[0]; port <= config.instancePorts[1]; port++)
              if (
                !reserved.has(port) &&
                !(
                  (
                    this.db.prepare('SELECT instance FROM reservations WHERE key=?').get(`tcp:${port}`) as
                      | {
                          instance: string;
                        }
                      | undefined
                  )?.instance !== instance?.id && this.db.prepare('SELECT key FROM reservations WHERE key=?').get(`tcp:${port}`)
                ) &&
                host.routeState(routes, { hostname: config.tailnetHostname, port, upstream: 'http://127.0.0.1:1', label: 'Recipe' }) === 'absent'
              ) {
                reserved.add(port);
                return port;
              }
            throw new Problem('PORT_CONFLICT', 'No unused instance ports');
          };
          for (const s of c.recipe.services) allocations.ports[s.id] = free();
          for (const p of c.recipe.previews) allocations.previews[p.serviceId] = free();
          instance = {
            id: c.instanceId,
            projectPath: c.common,
            checkoutPath: c.checkout,
            approvalId: matching?.id ?? randomUUID(),
            allocations: JSON.stringify(allocations),
          };
        }
      })
      .immediate();
    const resolved = await this.resolve(c, instance!);
    this.db
      .transaction(() => {
        let approval = matching;
        if (!approval) {
          const count = this.db.prepare("SELECT COUNT(*) n FROM approvals WHERE status='pending'").get() as {
            n: number;
          };
          if (count.n >= 20) throw new Problem('APPROVAL_LIMIT', 'At most 20 pending approvals');
          approval = {
            id: instance!.approvalId,
            projectPath: c.common,
            recipeHash: c.recipeHash,
            toolchainRevision: c.toolchainRevision,
            status: 'pending',
            requestedAt: new Date().toISOString(),
            decidedAt: null,
            decidedBy: null,
            preview: JSON.stringify(resolved.resolvedPreview),
          };
          if (this.approval(approval.id)) approval.id = randomUUID();
          this.db
            .prepare('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?)')
            .run(
              approval.id,
              approval.projectPath,
              approval.recipeHash,
              approval.toolchainRevision,
              approval.status,
              approval.requestedAt,
              null,
              null,
              approval.preview,
            );
        }
        instance!.approvalId = approval.id;
        if (!store.resources(instance!.id).length) this.db.prepare('DELETE FROM reservations WHERE instance=?').run(instance!.id);
        this.db
          .prepare(
            'INSERT INTO instances VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET approvalId=excluded.approvalId,allocations=excluded.allocations',
          )
          .run(instance!.id, c.common, c.checkout, approval.id, instance!.allocations);
        const a = JSON.parse(instance!.allocations) as Allocations;
        for (const port of [...Object.values(a.ports), ...Object.values(a.previews)]) {
          const existing = this.db.prepare('SELECT instance,resource FROM reservations WHERE key=?').get(`tcp:${port}`) as
            | {
                instance: string | null;
                resource: string | null;
              }
            | undefined;
          if (existing && existing.instance !== instance!.id && !store.resources(instance!.id).some((r) => r.id === existing.resource))
            throw new Problem('RESOURCE_CONFLICT', 'Instance allocation was reserved concurrently');
          if (!existing) this.db.prepare('INSERT INTO reservations(key,instance) VALUES (?,?)').run(`tcp:${port}`, instance!.id);
        }
        if (!retry)
          this.db
            .prepare('INSERT INTO recipe_requests VALUES (?,?,?,?,?)')
            .run(requestId, c.checkout, instance!.id, c.recipeHash, c.toolchainRevision);
      })
      .immediate();
    store.ensure(resolved.profile);
    // A stopped instance describes the newly reviewed allocations; live resources keep their recorded revision.
    if (!store.resources(instance!.id).length && !['accepted', 'running'].includes(store.latest(instance!.id)?.status ?? ''))
      this.db
        .prepare('UPDATE environments SET revision=?,observation=? WHERE id=?')
        .run(revision(resolved.profile), store.observation(resolved.profile), instance!.id);
    this.service.catalog.invalidate();
    const approval = this.approval(instance!.approvalId)!;
    return {
      status: approval.status === 'approved' ? ('approved' as const) : ('pending' as const),
      approvalUrl: this.url(approval.id),
      resolvedPreview: resolved.resolvedPreview,
    };
  }
  async startAllowed(id: string) {
    const instance = this.instances().find((i) => i.id === id);
    if (!instance) return this.service.lifecycle.config.profiles.some((p) => p.id === id);
    const state = await this.inspect(instance.checkoutPath);
    return state.valid && state.approval === 'approved' && state.approvalId === instance.approvalId;
  }
  async prepare(id: string) {
    const instance = this.instances().find((i) => i.id === id);
    if (!instance) return;
    const approval = this.approval(instance.approvalId)!;
    let c: Awaited<ReturnType<Recipes['context']>>;
    try {
      c = await this.context(instance.checkoutPath);
    } catch {
      throw new Problem('APPROVAL_REQUIRED', 'Recipe unavailable or changed; owner approval required', this.url(approval.id));
    }
    if (
      approval.status !== 'approved' ||
      approval.recipeHash !== c.recipeHash ||
      approval.toolchainRevision !== c.toolchainRevision ||
      approval.projectPath !== c.common
    )
      throw new Problem('APPROVAL_REQUIRED', 'Owner approval required', this.url(approval.id));
    const { profile } = await this.resolve(c, instance, true);
    this.profiles.set(id, profile);
  }
  async listApprovals() {
    return Promise.all(
      (this.db.prepare("SELECT * FROM approvals WHERE status='pending' ORDER BY requestedAt LIMIT 20").all() as Approval[]).map(async (row) => {
        const preview = JSON.parse(row.preview);
        const state = await this.inspect(preview.checkoutPath);
        return { ...row, preview, stale: !state.valid || state.approvalId !== row.id };
      }),
    );
  }
  async decide(id: string, approve: boolean) {
    const row = this.approval(id);
    if (!row) throw new Problem('NOT_FOUND', 'No approval request');
    if (approve) {
      const preview = JSON.parse(row.preview);
      const state = await this.inspect(preview.checkoutPath);
      if (!state.valid || state.approvalId !== id) throw new Problem('APPROVAL_REQUIRED', 'Recipe or toolchain changed; request a new review');
    }
    this.db
      .prepare('UPDATE approvals SET status=?,decidedAt=?,decidedBy=? WHERE id=?')
      .run(approve ? 'approved' : 'rejected', new Date().toISOString(), 'owner session', id);
    this.service.catalog.invalidate();
    return { id, status: approve ? 'approved' : 'rejected' };
  }
}
