#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, readFile, writeFile, stat, lstat, readlink, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const inside = (path, root) => { const r = relative(root, path); return r === '' || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };

// Setup creates owner files only; it does not start services or change Serve routes.
process.umask(0o077);
const [rootArgument = join(homedir(), 'code')] = process.argv.slice(2);
if (process.platform !== 'linux' || !process.getuid?.()) throw new Error('Run as the Linux installation owner, not root');
const root = await realpath(rootArgument);
const configDirectory = join(homedir(), '.config/rootlane');
const stateDirectory = join(homedir(), '.local/state/rootlane');
if ([configDirectory, stateDirectory].some(path => inside(path, root))) throw new Error('Configuration and state must be outside the project root');
for (const directory of [configDirectory, stateDirectory]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (inside(await realpath(directory), root)) throw new Error('Owner directories resolve inside the project root');
  const info = await stat(directory);
  if (info.uid !== process.getuid() || info.mode & 0o077) throw new Error(`Directory must be private and owned by you: ${directory}`);
}
const tailscale = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024 }));
if (tailscale.BackendState !== 'Running' || !tailscale.Self?.DNSName) throw new Error('A connected Tailscale node is required');
const hostname = tailscale.Self.DNSName.replace(/\.$/, '');
const config = { projectRoots: [root], observationRoots: [root], stateDirectory, port: 9480, origin: `https://${hostname}:19483`, tailnetHostname: hostname, telemetry: { enabled: false, port: 9481, retentionDays: 7 }, profiles: [], projects: [], toolchains: { node: process.execPath, venvs: {} }, instancePorts: [20000,20999] };
for (const [name, content] of [['config.json', JSON.stringify(config, null, 2) + '\n'], ['owner.credential', randomBytes(32).toString('hex') + '\n'], ['agent.credential', randomBytes(32).toString('hex') + '\n'], ['ingest.credential', randomBytes(32).toString('hex') + '\n']]) {
  try { await writeFile(join(configDirectory, name), content, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
for (const name of ['config.json', 'owner.credential', 'agent.credential', 'ingest.credential']) {
  const info = await stat(join(configDirectory, name));
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error('Existing owner files must be private and owned by you');
}
const existing = JSON.parse(await readFile(join(configDirectory, 'config.json'), 'utf8'));
if (existing.stateDirectory !== stateDirectory || JSON.stringify(existing.projectRoots) !== JSON.stringify([root]) || !Array.isArray(existing.observationRoots)) throw new Error('Existing config uses different state/roots. Review it and adjust Compose mounts; setup preserved the file.');
const journalGroup = (await stat('/var/log/journal')).gid;
let codexVersion = '';
try { codexVersion = /^codex-cli ([0-9][0-9A-Za-z.+-]*)\s*$/m.exec(execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 3000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'ignore'] }))?.[1] ?? ''; } catch {}
const values = { ROOTLANE_MCP_ADAPTER: resolve(fileURLToPath(new URL('rootlane-mcp-docker',import.meta.url))), ROOTLANE_OWNER_HOME: await realpath(homedir()), ROOTLANE_UID: process.getuid(), ROOTLANE_GID: process.getgid(), ROOTLANE_JOURNAL_GID: journalGroup, ROOTLANE_PROJECT_ROOT: root, ROOTLANE_CONFIG_DIR: configDirectory, ROOTLANE_STATE_DIR: stateDirectory, ROOTLANE_CODEX_VERSION: codexVersion };
const quote = value => `'${String(value).replaceAll("'", "\\'")}'`;
const release = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = join(release,'runtime/node');
if(await stat(join(runtime,'bin/node')).catch(()=>null))values.ROOTLANE_HOST_NODE=join(runtime,'bin/node');
const ingestEnv = join(configDirectory, 'ingest.env');
const previousEnv = await lstat(ingestEnv).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (previousEnv && (!previousEnv.isFile() || previousEnv.uid !== process.getuid() || previousEnv.mode & 0o077)) throw new Error('Existing ingest.env must be a private owner file');
const ingestToken = (await readFile(join(configDirectory, 'ingest.credential'), 'utf8')).trim();
if (!/^[^\r\n]{32,256}$/.test(ingestToken)) throw new Error('Ingest credential must contain 32–256 characters');
await writeFile(ingestEnv, `ROOTLANE_TELEMETRY_URL=http://127.0.0.1:${existing.telemetry?.port ?? 9481}\nROOTLANE_INGEST_TOKEN=${ingestToken}\n`, { mode: 0o600 });
const binDirectory = join(homedir(), '.local/bin');
await mkdir(binDirectory, { recursive: true, mode: 0o700 });
for (const name of ['rootlane-session-hook', 'rootlane-statusline']) {
  const command = join(binDirectory, name);
  const info = await lstat(command).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info) {
    if (!info.isSymbolicLink() || !(await readlink(command)).endsWith(`/deploy/${name}`)) throw new Error(`Existing command is not a Rootlane release symlink: ${command}`);
    await unlink(command);
  }
  await symlink(join(release, 'deploy', name), command);
}
await writeFile(join(release, '.env'), Object.entries(values).map(([key, value]) => `${key}=${quote(value)}`).join('\n') + '\n', { mode: 0o600 });
const binds = new Set([homedir(),...existing.observationRoots,...Object.values(existing.toolchains?.venvs??{}),...[existing.toolchains?.node,existing.toolchains?.python].filter(Boolean).map(p=>resolve(p,'..')), ...(existing.profiles ?? []).flatMap(p => p.services.map(s => resolve(s.executable, '..')))]);
if(values.ROOTLANE_HOST_NODE)binds.add(runtime);
// Include canonical executable directories and venv interpreter targets as well as configured paths.
for(const executable of [existing.toolchains?.node,existing.toolchains?.python,...(existing.profiles??[]).flatMap(p=>p.services.map(s=>s.executable)),...Object.values(existing.toolchains?.venvs??{}).map(p=>join(p,'bin/python'))].filter(Boolean)) {
  const actual=await realpath(executable).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(actual)binds.add(resolve(actual,'..'));
}
const volumes = [];
for (const candidate of binds) {
  const source = await realpath(candidate);
  if (['/etc', '/root', '/proc', '/sys'].some(blocked => inside(source, blocked)) || source === '/') throw new Error(`Refusing sensitive bind: ${source}`);
  if (source !== root) volumes.push({ type: 'bind', source, target: source, read_only: true });
}
await writeFile(join(release, 'compose.override.yaml'), JSON.stringify({ services: { rootlane: { volumes } } }, null, 2) + '\n', { mode: 0o600 });
console.log(`Owner files: ${configDirectory}\nState: ${stateDirectory}\nURL: ${config.origin}\nProfiles are initially empty; existing services remain observe-only.\nNext: docker compose up -d --build`);
