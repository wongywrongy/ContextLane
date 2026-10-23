import { z } from 'zod';
import { realpath, mkdir, stat, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { inside, orderedServices, profileSchema, revision, type Profile } from './config.js';
import { command } from './host/command.js';
import { Problem, id, recipeStatus } from './shared/contracts.js';
import { runtimeTools, proposeEnvironment, manifestRevisions, digest, viteLauncher, boundedFile } from './configuration.js';
import type { EnvironmentInspection } from './shared/contracts.js';
import type { Unit } from './host/types.js';
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
          requiredEnv: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).refine(v => !v.startsWith('ROOTLANE_'))).max(100).default([]),
          dependencies: z.array(id).max(16).default([]),
          readiness,
        }),
      )
      .min(1)
      .max(16),
    previews: z
      .array(z.strictObject({ serviceId: id, label: text.min(1).max(100), path:z.string().regex(/^\/(?!\/)[^\s#]*$/).max(256).optional() }))
      .min(1)
      .max(8),
    setup: z.array(text).max(20).default([]),
    restart: z.enum(['no','on-failure']).optional(),
    preparation: z.array(z.strictObject({
      command: z.array(text.min(1)).min(1).max(100).refine(a => !wrappers.has(basename(a[0]!)), 'Shell and env wrappers are forbidden'),
      cwd: text.default('.').refine(p => !isAbsolute(p) && !p.split(/[\\/]/).includes('..'), 'cwd must stay within checkout'),
      writes: z.array(text.min(1)).min(1).max(20), lifecycleScripts: z.boolean(),
      timeoutMs: z.number().int().min(1000).max(600000).default(300000),
    })).max(16).default([]),
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
            !['state', 'node', 'python', 'venv', 'vite-launcher'].includes(key) &&
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
export class Recipes {
  readonly profiles = new Map<string, Profile>();
  private queue: Promise<unknown> = Promise.resolve();
  private preparationTasks = new Map<string, Promise<void>>();
  constructor(readonly service: Rootlane) {}
  get db() {
    return this.service.lifecycle.store.db;
  }
  instances(checkout?: string, includeRetired = false) {
    return this.db
      .prepare(`SELECT * FROM instances WHERE ${includeRetired ? '1=1' : 'id NOT IN (SELECT instanceId FROM retired_instances)'} ${checkout ? 'AND checkoutPath=?' : ''} ORDER BY id LIMIT 100`)
      .all(...(checkout ? [checkout] : [])) as Instance[];
  }
  approval(id: string) {
    return this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as Approval | undefined;
  }
  private hostTools() {
    const {host,config}=this.service.lifecycle;
    return host.toolchains ? host.toolchains(process.env.ROOTLANE_HOST_NODE || config.toolchains.node || process.execPath) : Promise.resolve({} as Record<string,string>);
  }
  private checkoutBusy(path:string) {
    const {store}=this.service.lifecycle;
    return store.environments().some(env=>(JSON.parse(env.observation) as import('./state/store.js').Observation).projectPath===path && (store.resources(env.id).length || ['accepted','running'].includes(store.latest(env.id)?.status ?? '')));
  }
  private cleanupRequired(path:string) {
    return this.db.prepare("SELECT id FROM preparations WHERE checkoutPath=? AND json_extract(error,'$.code')='PREPARATION_CLEANUP_REQUIRED' ORDER BY rowid LIMIT 1").get(path) as {id:string}|undefined;
  }
  async identity(path: string, knownCommonDir?: string) {
    const { config } = this.service.lifecycle;
    const actual = await realpath(path).catch(() => null);
    if (!actual || !config.observationRoots.some(r => inside(actual,r))) throw new Problem('NOT_FOUND','Path is outside observation roots or unavailable');
    let checkout = actual, common = actual;
    if (knownCommonDir) common = await realpath(knownCommonDir);
    else {
      try {
        const lines = (await command('git',['rev-parse','--show-toplevel','--path-format=absolute','--git-common-dir'],{cwd:actual,timeout:1000,maxBuffer:4096})).trim().split('\n');
        if (lines[0] && lines[1]) { checkout = await realpath(lines[0]); common = await realpath(lines[1]); }
      } catch { /* A confirmed non-Git application uses its canonical directory. */ }
    }
    if (![checkout,common].every(p => config.observationRoots.some(r => inside(p,r)))) throw new Problem('NOT_FOUND','Checkout or Git metadata is outside observation roots');
    return {checkout,common};
  }
  private async context(path: string, _checkoutHint = false, knownCommonDir?: string) {
    const {config} = this.service.lifecycle;
    const {checkout,common} = await this.identity(path,knownCommonDir);
    const local = this.db.prepare('SELECT recipe,tools FROM local_recipes WHERE checkoutPath=?').get(checkout) as {recipe:string;tools:string}|undefined;
    let data: Buffer, source: 'Host-local'|'Project-shared' = 'Project-shared';
    try { data = await boundedFile(join(checkout,'.rootlane.json'),65536); }
    catch(error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !local) throw error;
      data = Buffer.from(local.recipe); source = 'Host-local';
    }
    let recipe: Recipe;
    try { recipe = recipeSchema.parse(JSON.parse(data.toString('utf8'))); }
    catch { throw new Problem('RECIPE_INVALID','Recipe must match the strict version 1 schema'); }
    const overrides = local ? JSON.parse(local.tools) : {};
    const host = await this.hostTools();
    const detected = await runtimeTools(checkout,config,overrides,host);
    const tools: Record<string,string> = {}, configuredTools: Record<string,string> = {};
    const values = [...recipe.services.flatMap(s => [...s.command,...Object.values(s.env),...(s.envFile ? [s.envFile] : [])]),...recipe.preparation.flatMap(p=>p.command)];
    for (const key of ['node','python','venv'] as const) if (values.some(v=>v.includes(`{${key}}`))) {
      const configured = overrides[key] ?? (key === 'venv' ? config.toolchains.venvs[common] ?? config.toolchains.venvs[basename(dirname(common))] : config.toolchains[key]) ?? detected[key];
      if (!configured) throw new Problem('TOOLCHAIN_MISSING',`Install or configure the ${key} toolchain on the host`);
      configuredTools[key] = configured;
      tools[key] = host[key] === configured ? configured : await realpath(configured).catch(() => {
        if (key === 'venv' && recipe.preparation.length && inside(configured,checkout)) return configured;
        throw new Problem('TOOLCHAIN_MISSING',`Toolchain path unavailable: ${key}`);
      });
    }
    const manifests = recipe.preparation.length ? await manifestRevisions(checkout,recipe) : {};
    return { checkout, common, recipe, source, tools, manifestRevisions:manifests,
      recipeHash: hash(recipe.preparation.length ? Buffer.concat([data,Buffer.from(JSON.stringify(manifests))]) : data),
      toolchainRevision: hash(JSON.stringify({configured:configuredTools,resolved:tools,...(values.some(v=>v.includes('{venv}'))?{venvInvocation:'preserve-v1'}:{}),...(values.includes('{vite-launcher}') ? {launcher:viteLauncher} : {})})),
      instanceId:`${slug(common === checkout ? checkout : dirname(common))}-${slug(checkout)}`,
    };
  }
  async inspect(path: string, knownCommonDir?: string): Promise<z.infer<typeof recipeStatus>> {
    try {
      const c = await this.context(path, true, knownCommonDir);
      const matching = this.db
        .prepare('SELECT * FROM approvals WHERE projectPath=? AND recipeHash=? AND toolchainRevision=?')
        .get(c.common, c.recipeHash, c.toolchainRevision) as Approval | undefined;
      const prior = this.db.prepare('SELECT id FROM approvals WHERE projectPath=? LIMIT 1').get(c.common);
      return {
        source: c.source,
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
            : key === 'vite-launcher'
              ? join(config.stateDirectory, 'launchers', 'vite.mjs')
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
      const executablePath = isAbsolute(cmd[0]!) ? cmd[0]! : join(c.checkout, cmd[0]!);
      const resolvedExecutable = await realpath(executablePath).catch(error => {
        if ((!launch && c.recipe.preparation.length && inside(executablePath,c.checkout)) || Object.values(c.tools).includes(executablePath) || (c.tools.venv && inside(executablePath,c.tools.venv))) return executablePath;
        throw error;
      });
      if (wrappers.has(basename(resolvedExecutable))) throw new Problem('RECIPE_INVALID', 'Resolved shell/env wrappers are forbidden');
      // Python selects its virtual environment from the invoked path, including bin/python symlinks.
      const executable = executablePath;
      let fromFile: Record<string, string> = {};
      let envFile: string | undefined;
      if (s.envFile) {
        const expandedFile = expand(s.envFile);
        const file = await realpath(expandedFile).catch(error => { if (!launch && (error as NodeJS.ErrnoException).code === 'ENOENT') return expandedFile; throw error; });
        envFile = file;
        if (config.observationRoots.some((root) => inside(file, root)))
          throw new Problem('PRIVATE_FILE_REQUIRED', 'envFile must be outside observation roots');
        try { fromFile = z
          .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string())
          .parse(parseEnv((await boundedFile(file, 65536, true)).toString('utf8'))); } catch(error) { if (launch || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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
        ...(c.recipe.restart ? {restart:c.recipe.restart} : {}),
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
      if (c.recipe.services.some(s=>s.command.includes('{vite-launcher}'))) {
        const directory = join(config.stateDirectory,'launchers');
        await mkdir(directory,{recursive:true,mode:0o700});
        if (!inside(await realpath(directory),await realpath(config.stateDirectory))) throw new Problem('PRIVATE_FILE_REQUIRED','Launcher directory escapes state');
        await writeFile(join(directory,'vite.mjs'),viteLauncher,{mode:0o600,flag:'w'});
      }
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
        envNames: [...new Set([...Object.keys(s.env), ...(envNames.get(s.id) ?? []), ...c.recipe.services.find(r=>r.id===s.id)!.requiredEnv])].sort(),
        port: s.port,
        readiness: s.readiness,
      })),
      previews: profile.previews.map((p) => ({
        serviceId: p.serviceId,
        label: p.label,
        port: p.httpsPort,
        url: `https://${config.tailnetHostname}:${p.httpsPort}${p.path ?? '/'}`,
      })),
      source:c.source, restart:c.recipe.restart, tools:c.tools, manifestRevisions:c.manifestRevisions,
      requiredEnv:[...new Set(c.recipe.services.flatMap(s=>s.requiredEnv))],
      preparation:c.recipe.preparation.map(p=>({...p,command:p.command.map(expand),cwd:join(c.checkout,p.cwd)})),
      setup: c.recipe.setup,
    };
    return { profile, resolvedPreview };
  }
  request(path: string, requestId: string, existingOnly=false) {
    const task = this.queue.then(() => this.requestUnlocked(path, requestId,existingOnly));
    this.queue = task.catch(() => {});
    return task;
  }
  private async requestUnlocked(path: string, requestId: string,existingOnly:boolean) {
    const c = await this.context(path),
      { config, host, store } = this.service.lifecycle;
    if(existingOnly && this.db.prepare('SELECT instanceId FROM retired_instances WHERE instanceId=?').get(c.instanceId))throw new Problem('INSTANCE_RETIRED','Request a new instance for this retired checkout');
    if(this.db.prepare('SELECT id FROM preparations WHERE id=?').get(requestId))throw new Problem('REQUEST_ID_REUSED','requestId belongs to preparation');
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
    if(retry && this.db.prepare('SELECT instanceId FROM retired_instances WHERE instanceId=?').get(retry.instanceId))throw new Problem('INSTANCE_RETIRED','This request belongs to a retired instance; use a new requestId for a new instance');
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
        config.telemetry.port,
        ...[config.origin, ...(config.additionalOrigins ?? [])].map((u) => Number(new URL(u).port || 443)),
        ...listeners.map((l) => l.port),
        ...config.profiles.flatMap((p) => [...p.services.map((s) => s.port), ...p.previews.map((p) => p.httpsPort)]),
        ...config.previewTargets.flatMap((t) => [t.port, t.httpsPort]),
      ]);
    const allocationsConflict = instance && !store.resources(instance.id).length && store.environment(instance.id)?.desired === 'stopped' && !['accepted','running'].includes(store.latest(instance.id)?.status ?? '') && Object.values(JSON.parse(instance.allocations) as Allocations).some(values=>Object.values(values).some(port=>reserved.has(port) || host.routeState(routes,{hostname:config.tailnetHostname,port,upstream:'http://127.0.0.1:1',label:'Recipe'}) !== 'absent'));
    this.db
      .transaction(() => {
        if (
          !instance || allocationsConflict ||
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
    const prerequisites=await this.inspectEnvironment(c.checkout);
    const preview={...resolved.resolvedPreview,prerequisites:[...prerequisites.blockers,...(!['not-needed','succeeded'].includes(prerequisites.preparationStatus)?[{code:'PREPARATION_REQUIRED',message:'Review and complete structured preparation before approving Start'}]:[])]};
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
            preview: JSON.stringify(preview),
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
        this.db.prepare('DELETE FROM retired_instances WHERE instanceId=?').run(instance!.id);
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
      resolvedPreview: preview,
    };
  }
  async startAllowed(id: string) {
    const instance = this.instances().find((i) => i.id === id);
    if (!instance) return this.service.lifecycle.config.profiles.some((p) => p.id === id);
    const state = await this.inspect(instance.checkoutPath);
    return state.valid && state.approval === 'approved' && state.approvalId === instance.approvalId;
  }
  async inspectEnvironment(path: string): Promise<EnvironmentInspection> {
    const {checkout} = await this.identity(path);
    const {config,store} = this.service.lifecycle;
    let source: EnvironmentInspection['source'] = null, proposal: Recipe|null = null;
    let tools: Record<string,string> = {}, blockers: EnvironmentInspection['blockers'] = [], warnings: string[] = [];
    let context: Awaited<ReturnType<Recipes['context']>>|undefined;
    try { context = await this.context(checkout); source = context.source; proposal = context.recipe; tools = context.tools; }
    catch(error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const suggested = await proposeEnvironment(checkout,config,await this.hostTools().catch(()=>({})));
        ({proposal,tools,blockers,warnings} = suggested);
      } else {
        blockers.push(error instanceof Problem ? {code:error.code,message:error.message} : {code:'RECIPE_INVALID',message:'Recipe cannot be read; repair the project recipe before configuring.'});
        const local=this.db.prepare('SELECT recipe,tools FROM local_recipes WHERE checkoutPath=?').get(checkout) as {recipe:string;tools:string}|undefined;
        try {const data=await boundedFile(join(checkout,'.rootlane.json'),65536);source='Project-shared';proposal=recipeSchema.parse(JSON.parse(data.toString('utf8')));}
        catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT' && local){try{proposal=recipeSchema.parse(JSON.parse(local.recipe));source='Host-local';}catch{/* Invalid configuration remains blocked. */}}}
        tools=await runtimeTools(checkout,config,local?JSON.parse(local.tools):{},await this.hostTools().catch(()=>({})));
        for(const key of ['node','python'] as const)if(proposal?.services.some(s=>s.command.some(v=>v.includes(`{${key}}`)))) {
          try {if(!tools[key])throw new Error();await access(tools[key],constants.X_OK);}
          catch{if(!blockers.some(b=>b.code==='TOOLCHAIN_MISSING' && b.message.includes(key)))blockers.push({code:'TOOLCHAIN_MISSING',message:`Install or configure a usable ${key} executable on the host`});}
        }
      }
    }
    const hostProfiles=!source?config.profiles.filter(p=>p.projectPath===checkout):[];
    if(hostProfiles.length){source='Host-local';proposal=null;blockers=[];warnings=['Commands are defined in the owner’s private host profiles. Edit those profiles on the host.'];tools=Object.fromEntries(hostProfiles.flatMap(p=>p.services.map(s=>[s.id,s.executable])));}
    const revisions = await manifestRevisions(checkout,proposal ?? undefined);
    const prerequisites=await Promise.allSettled([this.service.lifecycle.host.capabilities([]),this.service.lifecycle.host.connection(),this.service.lifecycle.host.guardedRoutes().then(supported=>{if(!supported)throw new Problem('GUARDED_WRITES_UNAVAILABLE','Update the Tailscale daemon to support guarded Serve writes before starting previews');})]);
    for(const result of prerequisites) {
      if(result.status==='rejected')blockers.push(result.reason instanceof Problem?{code:result.reason.code,message:result.reason.message}:{code:'HOST_UNAVAILABLE',message:'Host prerequisite observation failed'});
      else if(result.value && (result.value.status!=='connected' || result.value.hostname!==config.tailnetHostname))blockers.push({code:'TAILSCALE_UNAVAILABLE',message:'Connect the configured Tailscale node before starting or recovering previews'});
    }
    if (Object.values(revisions).includes('unreadable')) blockers.push({code:'INSPECTION_INCOMPLETE',message:'A relevant manifest or lockfile is unreadable or exceeds 1 MiB.'});
    const instanceId = context?.instanceId;
    const expand = (value:string) => value.replace(/\{(node|python|venv)\}/g,(_,key:string)=>tools[key] ?? `{${key}}`);
    const preparation = (proposal?.preparation ?? []).map(p=>({...p,command:p.command.map(expand),writes:p.writes.map(value=>{const resolved=expand(value);return isAbsolute(resolved)?resolved:join(checkout,p.cwd,resolved);}),cwd:join(checkout,p.cwd)}));
    const fingerprint = digest(JSON.stringify({proposal,tools,revisions}));
    if(this.cleanupRequired(checkout))blockers.push({code:'PREPARATION_CLEANUP_REQUIRED',message:'Verify cleanup of the recorded preparation job before configuring or starting this checkout.'});
    const record = this.db.prepare("SELECT id,status,fingerprint,error,unit,review,createdAt,finishedAt FROM preparations WHERE checkoutPath=? ORDER BY coalesce(json_extract(error,'$.code')='PREPARATION_CLEANUP_REQUIRED',0) DESC, rowid DESC LIMIT 1").get(checkout) as {id:string;status:'running'|'succeeded'|'failed'|'interrupted';fingerprint:string;error:string|null;unit:string|null;review:string;createdAt:string;finishedAt:string|null}|undefined;
    const preparationStatus = record?.status === 'running' ? 'running' : !preparation.length ? 'not-needed' : record?.fingerprint === fingerprint ? record.status : 'review';
    const requiredEnv: EnvironmentInspection['requiredEnv'] = [];
    for (const service of proposal?.services ?? []) {
      let values:Record<string,string> = {...service.env};
      let file:string|null = service.envFile?.replace('{state}',join(config.stateDirectory,'instances',instanceId ?? 'pending')) ?? null;
      if (file) {
        file = file.replace(/^~(?=\/|$)/,process.env.ROOTLANE_OWNER_HOME || homedir());
        try {
          const actual = await realpath(file);
          if (config.observationRoots.some(root=>inside(actual,root))) throw new Problem('PRIVATE_FILE_REQUIRED','Environment file must be outside observation roots');
          values = {...values,...Object.fromEntries(Object.entries(parseEnv((await boundedFile(actual,65536,true)).toString('utf8'))).filter((entry): entry is [string,string]=>entry[1] !== undefined))};
        } catch(error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') blockers.push(error instanceof Problem ? {code:error.code,message:error.message} : {code:'ENV_FILE_UNAVAILABLE',message:`${file}: private owner-owned environment file required`});
        }
      }
      for (const name of service.requiredEnv) {
        const missing = !values[name]; requiredEnv.push({name,missing,file});
        if (missing) blockers.push({code:'ENV_REQUIRED',message:`${service.id}: set ${name}${file ? ` in ${file} (mode 0600)` : ' in an owner-controlled envFile'}`});
      }
      if (service.command.includes('{vite-launcher}')) {
        try { createRequire(join(checkout,service.cwd,'package.json')).resolve('vite/package.json'); }
        catch { if (preparationStatus === 'not-needed' || preparationStatus === 'succeeded') blockers.push({code:'DEPENDENCIES_MISSING',message:`${service.id}: Vite is unavailable; review preparation or install the declared dependencies.`}); }
      }
    }
    let nextAction: EnvironmentInspection['nextAction'] = !source ? 'Configure environment' : preparationStatus !== 'not-needed' && preparationStatus !== 'succeeded' ? 'Review preparation' : 'Review configuration';
    if (source && context && ['not-needed','succeeded'].includes(preparationStatus) && !blockers.length) {
      const state = await this.inspect(checkout);
      if (state.approval === 'approved') {
        nextAction = 'Start';
        if (store.environment(context.instanceId)) {
          const environment = await this.service.lifecycle.get({environmentId:context.instanceId});
          if (environment.observationError) nextAction = 'Retry observation';
          else if (environment.application === 'ready' && environment.preview === 'available') nextAction = 'Open';
          else if (store.resources(context.instanceId).length) nextAction = 'Recover';
        }
      }
    }
    if(hostProfiles.length) {
      const environment=await this.service.lifecycle.get({environmentId:hostProfiles[0].id});
      nextAction=environment.observationError?'Retry observation':environment.application==='ready'&&environment.preview==='available'?'Open':store.resources(environment.id).length?'Recover':'Start';
    }
    const unit=record?.unit?(JSON.parse(record.unit) as Unit).name:null,total=record?JSON.parse(record.review).length:0;
    return {path:checkout,source,proposal,fingerprint,tools,blockers,warnings,manifestRevisions:revisions,preparation,preparationStatus,preparationError:record?.error ? JSON.parse(record.error) : null,requiredEnv,nextAction,
      ...(context?{environmentId:context.instanceId}:hostProfiles[0]?{environmentId:hostProfiles[0].id}:{}),
      ...(record?{preparationProgress:{id:record.id,unit,step:record.status==='succeeded'?total:unit?Number(unit.match(/-(\d+)\.service$/)?.[1] ?? 0)+1:0,total,startedAt:record.createdAt,finishedAt:record.finishedAt}}:{}),};
  }
  async configure(path:string, raw:unknown, tools:Record<string,string>, fingerprint:string) {
    const inspection = await this.inspectEnvironment(path);
    if (inspection.fingerprint !== fingerprint) throw new Problem('CONFIGURATION_CHANGED','Inspection changed; review it again before saving');
    const {checkout} = await this.identity(path);
    if(this.cleanupRequired(checkout))throw new Problem('PREPARATION_CLEANUP_REQUIRED','Verify recorded preparation cleanup before changing configuration');
    const recipe = recipeSchema.parse(raw);
    if (inspection.source === 'Project-shared' && JSON.stringify(recipe) !== JSON.stringify(inspection.proposal)) throw new Problem('PROJECT_RECIPE_AUTHORITATIVE','Export changes for review in the project recipe; host-local configuration cannot replace it');
    if (this.preparationTasks.has(checkout) || this.db.prepare("SELECT id FROM preparations WHERE checkoutPath=? AND status='running'").get(checkout)) throw new Problem('OPERATION_IN_PROGRESS','Wait for preparation before changing configuration');
    if (this.checkoutBusy(checkout)) throw new Problem('NEEDS_STOP','Stop this checkout before changing runtime configuration');
    this.db.prepare('INSERT INTO local_recipes VALUES (?,?,?,?) ON CONFLICT(checkoutPath) DO UPDATE SET recipe=excluded.recipe,tools=excluded.tools,updatedAt=excluded.updatedAt').run(checkout,JSON.stringify(recipe),JSON.stringify(tools),new Date().toISOString());
    this.service.catalog.invalidate();
    return this.inspectEnvironment(checkout);
  }
  async runPreparation(path:string, fingerprint:string, requestId:string) {
    const prior = this.db.prepare('SELECT checkoutPath,fingerprint,status FROM preparations WHERE id=?').get(requestId) as {checkoutPath:string;fingerprint:string;status:string}|undefined;
    if (prior) {
      if (prior.checkoutPath !== path || prior.fingerprint !== fingerprint) throw new Problem('REQUEST_ID_REUSED','Preparation request belongs to another review');
      return {id:requestId,status:prior.status};
    }
    if (this.db.prepare('SELECT id FROM requests WHERE id=?').get(requestId) || this.db.prepare('SELECT id FROM recipe_requests WHERE id=?').get(requestId)) throw new Problem('REQUEST_ID_REUSED','Request ID belongs to another action');
    const inspection = await this.inspectEnvironment(path);
    if(this.cleanupRequired(inspection.path))throw new Problem('PREPARATION_CLEANUP_REQUIRED','Interrupted preparation cleanup must be verified before retrying');
    if (!inspection.source || inspection.fingerprint !== fingerprint) throw new Problem('CONFIGURATION_CHANGED','Save and review the current configuration before preparation');
    if (inspection.blockers.some(b=>b.code !== 'ENV_REQUIRED' && b.code !== 'DEPENDENCIES_MISSING')) throw new Problem('PREREQUISITES_REQUIRED',inspection.blockers.map(b=>b.message).join('; '));
    if (!inspection.preparation.length) throw new Problem('NOT_FOUND','No structured preparation commands');
    const {store,host} = this.service.lifecycle;
    if (this.preparationTasks.has(inspection.path) || this.db.prepare("SELECT id FROM preparations WHERE checkoutPath=? AND status='running'").get(inspection.path)) throw new Problem('OPERATION_IN_PROGRESS','Preparation is already running');
    if (this.checkoutBusy(inspection.path)) throw new Problem('NEEDS_STOP','Stop this checkout before preparing it');
    this.db.prepare('INSERT INTO preparations VALUES (?,?,?,\'running\',?,NULL,NULL,?,NULL)').run(requestId,inspection.path,fingerprint,JSON.stringify(inspection.preparation),new Date().toISOString());
    const task = Promise.resolve().then(async()=>{
      try {
        if (!host.runPreparation) throw new Problem('MISSING_CAPABILITY','Host preparation support is unavailable');
        for (const [index,step] of inspection.preparation.entries()) {
          const cwd = await realpath(step.cwd);
          if (!inside(cwd,inspection.path)) throw new Problem('RECIPE_INVALID','Preparation directory escapes checkout');
          const executable = isAbsolute(step.command[0]) ? step.command[0] : join(cwd,step.command[0]);
          const actual=await realpath(executable).catch(error=>{
            if(Object.values(inspection.tools).includes(executable) || (inspection.tools.venv && inside(executable,inspection.tools.venv)))return executable;
            throw error;
          });
          if (wrappers.has(basename(actual))) throw new Problem('RECIPE_INVALID','Preparation shell/env wrappers are forbidden');
          const unit: Unit = {name:`rootlane-preparation-${requestId}-${index}.service`,marker:`rootlane:${store.installation}:preparation:${requestId}:${index}`,serviceId:'preparation',port:0,readiness:{path:'/',status:200,bodyIncludes:'',timeoutMs:1000},invocation:null};
          this.db.prepare('UPDATE preparations SET unit=? WHERE id=?').run(JSON.stringify(unit),requestId);
          await host.runPreparation(unit,{...step,cwd,command:[executable,...step.command.slice(1)]});
        }
        const current = await this.inspectEnvironment(inspection.path);
        if(current.fingerprint!==fingerprint)throw new Problem('PREPARATION_CHANGED','Manifests, lockfiles or configuration changed during preparation. Review the current revisions and prepare again before approving Start.');
        this.db.prepare("UPDATE preparations SET status='succeeded',finishedAt=? WHERE id=?").run(new Date().toISOString(),requestId);
      } catch(error) {
        const detail = error instanceof Problem ? {code:error.code,message:error.message} : {code:'PREPARATION_FAILED',message:'Preparation failed; inspect its recorded host systemd unit journal.'};
        this.db.prepare('UPDATE preparations SET error=? WHERE id=?').run(JSON.stringify(detail),requestId);
        try {await this.cleanPreparationUnit(requestId);}catch {/* Keep the durable cleanup blocker until owner cleanup succeeds. */}
        this.db.prepare("UPDATE preparations SET status='failed',finishedAt=? WHERE id=?").run(new Date().toISOString(),requestId);
      } finally { this.service.catalog.invalidate(); }
    }).finally(()=>this.preparationTasks.delete(inspection.path));
    this.preparationTasks.set(inspection.path,task);
    return {id:requestId,status:'running'};
  }
  private async cleanPreparationUnit(id:string) {
    const row=this.db.prepare('SELECT unit,error FROM preparations WHERE id=?').get(id) as {unit:string|null;error:string|null};
    if(!row.unit)return;
    const unit=JSON.parse(row.unit) as Unit,host=this.service.lifecycle.host;
    this.db.prepare('UPDATE preparations SET error=? WHERE id=?').run(JSON.stringify({code:'PREPARATION_CLEANUP_REQUIRED',message:'Recorded job cleanup is unverified. Restore host observation or resolve its ownership conflict, then verify cleanup.'}),id);
    await host.stopUnit(unit);
    const current=await host.inspectUnit(unit.name);
    if(current && (current.marker!==unit.marker || !['inactive','failed'].includes(current.state)))throw new Problem('OWNERSHIP_CONFLICT','Recorded preparation unit is not verified stopped');
    this.db.prepare('UPDATE preparations SET error=? WHERE id=?').run(row.error && JSON.parse(row.error).code!=='PREPARATION_CLEANUP_REQUIRED' ? row.error : JSON.stringify({code:'PREPARATION_FAILED',message:'Job stopped and cleanup verified. Review preparation before retrying.'}),id);
  }
  async cleanupPreparation(id:string) {
    const row=this.db.prepare('SELECT checkoutPath,status,error FROM preparations WHERE id=?').get(id) as {checkoutPath:string;status:string;error:string|null}|undefined;
    if(!row)throw new Problem('NOT_FOUND','No recorded preparation');
    if(row.status==='running' || this.preparationTasks.has(row.checkoutPath))throw new Problem('OPERATION_IN_PROGRESS','Wait for the preparation job to finish');
    if(JSON.parse(row.error ?? 'null')?.code!=='PREPARATION_CLEANUP_REQUIRED')return {id,cleaned:true};
    const task=this.cleanPreparationUnit(id).finally(()=>{this.preparationTasks.delete(row.checkoutPath);this.service.catalog.invalidate();});
    this.preparationTasks.set(row.checkoutPath,task);
    await task;
    return {id,cleaned:true};
  }
  async reconcilePreparation() {
    const rows = this.db.prepare("SELECT id,unit FROM preparations WHERE status='running' OR json_extract(error,'$.code')='PREPARATION_CLEANUP_REQUIRED'").all() as {id:string;unit:string|null}[];
    for (const row of rows) {
      this.db.prepare("UPDATE preparations SET status='interrupted',finishedAt=? WHERE id=?").run(new Date().toISOString(),row.id);
      try {await this.cleanPreparationUnit(row.id);}catch {/* Owner cleanup remains available while other jobs reconcile. */}
    }
  }
  async drain() { await Promise.all(this.preparationTasks.values()); }
  async retire(id:string) {
    const {store,host} = this.service.lifecycle;
    const instance = this.instances(undefined,true).find(i=>i.id===id);
    if (!instance) throw new Problem('NOT_FOUND','No recorded recipe instance');
    if (store.environment(id)?.desired !== 'stopped' || store.resources(id).length || ['accepted','running'].includes(store.latest(id)?.status ?? '')) throw new Problem('NEEDS_STOP','Stop and verify cleanup before retiring this instance');
    const history=store.resources(id,true);
    const latestUnits=new Map(history.filter(r=>r.kind==='unit').map(row=>[(JSON.parse(row.data) as Unit).name,row]));
    const previewPorts=new Set(Object.values((JSON.parse(instance.allocations) as Allocations).previews));
    for (const row of [...latestUnits.values(),...history.filter(r=>r.kind==='route' && previewPorts.has(JSON.parse(r.data).port))]) {
      if (row.kind === 'unit') {
        const unit = JSON.parse(row.data) as Unit, current = await host.inspectUnit(unit.name);
        if (current && (current.marker !== unit.marker || !['inactive','failed'].includes(current.state))) throw new Problem('CLEANUP_UNVERIFIED','A recorded unit still exists or changed ownership');
      } else if (host.routeState(await host.routes(),JSON.parse(row.data)) === 'matching') throw new Problem('CLEANUP_UNVERIFIED','A recorded route still exists');
    }
    this.db.transaction(()=>{
      if (store.resources(id).length || ['accepted','running'].includes(store.latest(id)?.status ?? '')) throw new Problem('OPERATION_IN_PROGRESS','Instance changed during retirement');
      this.db.prepare('DELETE FROM reservations WHERE instance=?').run(id);
      this.db.prepare('INSERT OR IGNORE INTO retired_instances VALUES (?,?)').run(id,new Date().toISOString());
    }).immediate();
    this.profiles.delete(id); this.service.catalog.invalidate();
    return {retired:true,environmentId:id};
  }
  async prepare(id: string) {
    let instance = this.instances().find((i) => i.id === id);
    if (!instance) {
      const profile=this.service.lifecycle.config.profiles.find(p=>p.id===id);
      if(profile && this.cleanupRequired(profile.projectPath))throw new Problem('PREPARATION_CLEANUP_REQUIRED','Verify recorded preparation cleanup before starting');
      return;
    }
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
    const inspection = await this.inspectEnvironment(instance.checkoutPath);
    if (inspection.blockers.length || ['review','running','failed','interrupted'].includes(inspection.preparationStatus)) throw new Problem('PREREQUISITES_REQUIRED', [...inspection.blockers.map(b=>b.message), ...(inspection.preparationStatus !== 'not-needed' && inspection.preparationStatus !== 'succeeded' ? ['Review and complete preparation first'] : [])].join('; '));
    const {store}=this.service.lifecycle;
    if(store.environment(id)?.desired==='stopped' && !store.resources(id).length && !['accepted','running'].includes(store.latest(id)?.status ?? '')) {
      await this.request(instance.checkoutPath,randomUUID(),true);
      instance=this.instances().find(i=>i.id===id)!;
    }
    const { profile } = await this.resolve(c, instance, true);
    this.profiles.set(id, profile);
  }
  async listApprovals() {
    return Promise.all(
      (this.db.prepare("SELECT * FROM approvals WHERE status='pending' ORDER BY requestedAt LIMIT 20").all() as Approval[]).map(async (row) => {
        const preview = JSON.parse(row.preview);
        const state = await this.inspect(preview.checkoutPath);
        const inspected=await this.inspectEnvironment(preview.checkoutPath).catch(()=>null);
        preview.prerequisites=inspected?[...inspected.blockers,...(!['not-needed','succeeded'].includes(inspected.preparationStatus)?[{code:'PREPARATION_REQUIRED',message:'Review and complete structured preparation before approving Start'}]:[])]:[{code:'NOT_FOUND',message:'Checkout is unavailable'}];
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
      const inspected=await this.inspectEnvironment(preview.checkoutPath);
      if(inspected.blockers.length || !['not-needed','succeeded'].includes(inspected.preparationStatus))throw new Problem('PREREQUISITES_REQUIRED',[...inspected.blockers.map(b=>b.message),...(!['not-needed','succeeded'].includes(inspected.preparationStatus)?['Review and complete preparation first']:[])].join('; '));
    }
    this.db
      .prepare('UPDATE approvals SET status=?,decidedAt=?,decidedBy=? WHERE id=?')
      .run(approve ? 'approved' : 'rejected', new Date().toISOString(), 'owner session', id);
    this.service.catalog.invalidate();
    return { id, status: approve ? 'approved' : 'rejected' };
  }
}
