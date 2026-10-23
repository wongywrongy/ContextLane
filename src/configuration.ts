import { open, realpath, access, opendir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, isAbsolute, delimiter, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { inside, type Config } from './config.js';
import { recipeSchema, type Recipe } from './recipes.js';
import { Problem, type EnvironmentInspection } from './shared/contracts.js';

export const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export async function boundedFile(path: string, limit = 65536, privateOwner = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Problem('RECIPE_INVALID','File is not regular or exceeds the read limit');
    if (privateOwner && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600)) throw new Problem('PRIVATE_FILE_REQUIRED','File requires owner ownership and mode 0600');
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Problem('RECIPE_INVALID','File exceeds the read limit');
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}
export async function executable(name: string) {
  for (const directory of (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, name);
    try { await access(path, constants.X_OK); return await realpath(path); } catch { /* Try the next PATH entry. */ }
  }
  return null;
}
export async function runtimeTools(path: string, config: Config, overrides: Record<string, string> = {}, host: Record<string,string> = {}) {
  const tools: Record<string, string> = {};
  const candidates = {
    node: overrides.node ?? config.toolchains.node ?? host.node ?? await executable('node'),
    python: overrides.python ?? config.toolchains.python ?? host.python ?? await executable('python3'),
    venv: overrides.venv ?? config.toolchains.venvs[path] ?? join(path, '.venv'),
  };
  for (const [key, value] of Object.entries(candidates)) if (value) tools[key] = host[key]===value ? value : await realpath(value).catch(() => value);
  return tools;
}
// Only file contents used to select commands or install dependencies bind preparation approval.
export async function manifestRevisions(path: string, recipe?: Recipe) {
  const revisions: Record<string, string> = {};
  const dirs = new Set(['.', ...(recipe?.services.map(s => s.cwd) ?? []), ...(recipe?.preparation.map(step=>step.cwd) ?? [])]);
  const names = ['package.json','package-lock.json','npm-shrinkwrap.json','pnpm-lock.yaml','yarn.lock','bun.lock','bun.lockb','requirements.txt','pyproject.toml','uv.lock','poetry.lock','.env.example'];
  let bytes = 0;
  for (const dir of dirs) for (const name of names) {
    const key = join(dir, name), candidate = join(path, key);
    try {
      if (!inside(await realpath(dirname(candidate)),path) || bytes >= 4 * 1048576) throw new Error('Inspection bounds');
      const data = await boundedFile(candidate,1048576); bytes += data.length; revisions[key] = digest(data);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') revisions[key] = 'unreadable';
    }
  }
  return revisions;
}
export async function proposeEnvironment(path: string, config: Config, host: Record<string,string> = {}) {
  const blockers: EnvironmentInspection['blockers'] = [], warnings: string[] = [];
  const tools = await runtimeTools(path, config, {}, host);
  const services: Recipe['services'] = [], preparation: Recipe['preparation'] = [];
  const requiredEnv = new Set<string>();
  let reads = 0;
  const read = async (file: string) => {
    if (++reads > 64) { warnings.push('Inspection file limit reached (64).'); return ''; }
    const candidate = join(path, file);
    try {
      if (!inside(await realpath(dirname(candidate)), path)) throw new Error('Directory escapes checkout');
      return (await boundedFile(candidate)).toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') blockers.push({ code: 'INSPECTION_INCOMPLETE', message: `${file}: regular readable file of at most 64 KiB required` });
      return '';
    }
  };
  const json = async (file: string): Promise<Record<string, any> | null> => {
    const text = await read(file);
    if (!text) return null;
    try { const value = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch { /* Report malformed metadata without returning contents. */ }
    blockers.push({ code: 'MANIFEST_INVALID', message: `${file}: expected a JSON object` }); return null;
  };
  const root = await json('package.json');
  const packages: { cwd: string; manifest: Record<string, any> }[] = root ? [{ cwd: '.', manifest: root }] : [];
  const patterns = Array.isArray(root?.workspaces) ? root.workspaces : root?.workspaces?.packages ?? [];
  if(Array.isArray(patterns) && patterns.length>16)blockers.push({code:'INSPECTION_INCOMPLETE',message:'Workspace pattern limit reached (16); configure remaining services manually.'});
  if (Array.isArray(patterns)) for (const pattern of patterns.slice(0,16)) {
    if (typeof pattern !== 'string' || isAbsolute(pattern) || pattern.split('/').includes('..') || !/^[\w./-]+(?:\/\*)?$/.test(pattern)) {
      warnings.push('A workspace pattern needs manual configuration.'); continue;
    }
    let dirs = [pattern];
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0,-2);
      try {
        if(!inside(await realpath(join(path,parent)),path))throw new Error('Workspace escapes checkout');
        dirs=[];let entries=0;
        for await(const entry of await opendir(join(path,parent))) {
          if(++entries>128 || dirs.length>=16){blockers.push({code:'INSPECTION_INCOMPLETE',message:`Workspace directory limit reached at ${parent}; configure remaining services manually.`});break;}
          if(entry.isDirectory())dirs.push(join(parent,entry.name));
        }
      }
      catch { blockers.push({code:'WORKSPACE_UNAVAILABLE',message:`Workspace directory ${parent} is unavailable`}); continue; }
    }
    for (const cwd of dirs) { const manifest = await json(join(cwd,'package.json')); if (manifest) packages.push({ cwd, manifest }); }
  }
  let hasNode = false;
  const packageServices=new Map<string,string>();
  for (const { cwd, manifest } of packages) {
    const deps = { ...manifest.dependencies, ...manifest.devDependencies };
    const script = manifest.scripts?.dev;
    if(cwd==='.' && Array.isArray(patterns) && patterns.length && !(typeof script==='string' && /^vite(?:\s|$)/.test(script)) && !await read('index.html'))continue;
    if (!deps.vite && !(typeof script === 'string' && /^vite(?:\s|$)/.test(script))) continue;
    hasNode = true;
    if (typeof script === 'string' && script.trim() !== 'vite') {
      blockers.push({code:'CUSTOM_LAUNCHER',message:`${join(cwd,'package.json')}: review custom dev command; automatic Vite launch supports the plain vite script`}); continue;
    }
    if (services.length >= 8) { blockers.push({code:'SERVICE_LIMIT',message:'Configure remaining workspace services manually (at most eight previews).'}); break; }
    const id = cwd === '.' ? 'web' : basename(cwd).replace(/[^\w-]/g,'-').slice(0,40);
    if (services.some(s => s.id === id)) { blockers.push({code:'AMBIGUOUS_SERVICE',message:`Duplicate workspace service name ${id}`}); continue; }
    if(typeof manifest.name==='string')packageServices.set(manifest.name,id);
    services.push({id,cwd,command:['{node}','{vite-launcher}'],env:{},dependencies:[],requiredEnv:[],readiness:{path:'/',status:200,bodyIncludes:'<',timeoutMs:15000}});
  }
  for(const service of services){const manifest=packages.find(p=>p.cwd===service.cwd)?.manifest;service.dependencies=Object.keys(manifest?.dependencies ?? {}).flatMap(name=>packageServices.has(name) && packageServices.get(name)!==service.id?[packageServices.get(name)!]:[]);}
  if (hasNode) {
    const declared = typeof root?.packageManager === 'string' ? root.packageManager.split('@')[0] : null;
    const locks: string[] = [];
    for (const [file,manager] of [['package-lock.json','npm'],['npm-shrinkwrap.json','npm'],['pnpm-lock.yaml','pnpm'],['yarn.lock','yarn'],['bun.lock','bun'],['bun.lockb','bun']]) if (await read(file)) locks.push(manager);
    const managers = new Set(locks);
    if (managers.size > 1 || (declared && locks.some(m => m !== declared))) blockers.push({code:'PACKAGE_MANAGER_AMBIGUOUS',message:'Declared package manager and lockfiles disagree; choose and repair them before preparation.'});
    const manager = declared ?? locks[0] ?? 'npm', tool = host[manager] ?? await executable(manager);
    if (!tool || !['npm','pnpm','yarn','bun'].includes(manager)) blockers.push({code:'TOOLCHAIN_MISSING',message:`Install the declared ${manager} package manager on the host.`});
    else {
      const args = manager === 'npm' ? [locks.includes('npm') ? 'ci' : 'install'] : manager === 'pnpm' ? ['install', ...(locks.includes(manager) ? ['--frozen-lockfile'] : [])] : manager === 'yarn' ? ['install'] : ['install', ...(locks.includes(manager) ? ['--frozen-lockfile'] : [])];
      const lockfile=({npm:'package-lock.json',pnpm:'pnpm-lock.yaml',yarn:'yarn.lock',bun:'bun.lock'} as Record<string,string>)[manager];
      preparation.push({command:[tool,...args],cwd:'.',writes:['node_modules',...(!locks.length ? [lockfile] : [])],lifecycleScripts:true,timeoutMs:300000});
    }
    if (!tools.node) blockers.push({code:'TOOLCHAIN_MISSING',message:'Install Node.js on the host or configure an absolute Node executable.'});
  }
  const requirements = await read('requirements.txt'), pyproject = await read('pyproject.toml');
  if (/\bfastapi\b/i.test(requirements + pyproject)) {
    if(!/\buvicorn\b/i.test(requirements+pyproject))blockers.push({code:'DEPENDENCY_MISSING',message:'Declare Uvicorn in requirements.txt or Python project dependencies before preparation.'});
    const candidates: string[] = [];
    for (const file of ['main.py','app.py','app/main.py','src/main.py']) {
      const text = await read(file);
      const matches = [...text.matchAll(/^([A-Za-z_]\w*)\s*=\s*(?:fastapi\.)?FastAPI\s*\(/gm)];
      for (const match of matches) candidates.push(`${file.slice(0,-3).replaceAll('/','.')}:${match[1]}`);
    }
    if (candidates.length !== 1) blockers.push({code:'COMMAND_AMBIGUOUS',message:'Select the FastAPI module and application object; no unique static FastAPI assignment was found.'});
    else {
      services.push({id:'api',cwd:'.',command:['{venv}/bin/python','-m','uvicorn',candidates[0],'--host','127.0.0.1','--port','{port:api}'],env:{},dependencies:[],requiredEnv:[],readiness:{path:'/openapi.json',status:200,bodyIncludes:'"openapi"',timeoutMs:15000}});
      if (!tools.python) blockers.push({code:'TOOLCHAIN_MISSING',message:'Install Python 3 with venv support on the host.'});
      else preparation.push({command:['{python}','-m','venv','{venv}'],cwd:'.',writes:['{venv}'],lifecycleScripts:false,timeoutMs:60000});
      preparation.push({command:['{venv}/bin/python','-m','pip','install',...(requirements ? ['-r','requirements.txt'] : ['-e','.'])],cwd:'.',writes:['{venv}',...(!requirements?['build','**/*.egg-info']:[])],lifecycleScripts:true,timeoutMs:300000});
    }
  }
  for (const {cwd} of packages.length ? packages : [{cwd:'.'}]) for (const line of (await read(join(cwd,'.env.example'))).split('\n')) {
    const name = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=/)?.[1];
    if (name && !name.startsWith('ROOTLANE_')) requiredEnv.add(name);
  }
  if(requiredEnv.size)warnings.push('Environment names were inferred from .env.example; review which variables are required before saving.');
  if (!services.length && !blockers.length) blockers.push({code:'UNSUPPORTED_PROJECT',message:'Provide a reviewed recipe. Automatic proposals support plain Vite and FastAPI/Uvicorn applications.'});
  const parsed = services.length ? recipeSchema.safeParse({version:1,services:services.map(s => ({...s,requiredEnv:[...requiredEnv],...(requiredEnv.size ? {envFile:'{state}/environment.env'} : {})})),previews:services.slice(0,8).map(s=>({serviceId:s.id,label:s.id,...(s.command.includes('uvicorn')?{path:'/docs'}:{})})),preparation,restart:'on-failure',setup:[]}) : null;
  if(parsed && !parsed.success)blockers.push({code:'DEPENDENCIES_AMBIGUOUS',message:'Service dependencies or identifiers require manual review before a recipe can be generated.'});
  const proposal=parsed?.success?parsed.data:null;
  return { proposal, blockers, warnings, tools };
}

export const viteLauncher = `import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(process.cwd() + '/package.json');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const origin = new URL(process.env.ROOTLANE_PREVIEW_ORIGIN);
const port = Number(process.env.ROOTLANE_PORT);
const options = {host:'127.0.0.1',port,strictPort:true,allowedHosts:[origin.hostname],origin:origin.origin,hmr:{protocol:'wss',host:origin.hostname,port,clientPort:Number(origin.port || 443)}};
const server = await createServer({server:options,plugins:[{name:'rootlane-reviewed-server',enforce:'post',configResolved(config){
  if(config.server.https || config.server.hmr?.server) throw new Error('Rootlane Vite launcher requires HTTP loopback and a shared HMR listener; review custom HTTPS/HMR configuration.');
  // Vite merges allowedHosts=true permissively; enforce the reviewed settings after configuration resolution.
  Object.assign(config.server,options);
}}]});
await server.listen();
`;
