import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, privateFile, inside } from './config.js';
import { Store } from './state/store.js';
import { LinuxHost } from './host/linux.js';
import { instanceLock } from './host/lock.js';
import { Lifecycle } from './lifecycle/service.js';
import { Catalog } from './catalog/discovery.js';
import { Rootlane } from './service.js';
import { createServer } from './http/server.js';
process.umask(0o077);
const configPath = process.env.ROOTLANE_CONFIG;
const ownerPath = process.env.ROOTLANE_OWNER_CREDENTIAL_FILE;
const agentPath = process.env.ROOTLANE_AGENT_CREDENTIAL_FILE;
if (!configPath || !ownerPath || !agentPath) throw new Error('ROOTLANE_CONFIG, ROOTLANE_OWNER_CREDENTIAL_FILE and ROOTLANE_AGENT_CREDENTIAL_FILE are required');
const config = await loadConfig(configPath);
await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
const statePath = await realpath(config.stateDirectory); const stateStat = await stat(statePath);
if (stateStat.uid !== process.getuid?.() || stateStat.mode & 0o077 || config.observationRoots.some(r => inside(statePath, r))) throw new Error('State directory must be private, owner-controlled and outside observation roots');
for (const credentialPath of [ownerPath, agentPath]) {
  const actual = await realpath(credentialPath);
  if (config.observationRoots.some(root => inside(actual, root))) throw new Error('Credentials must be outside observation roots');
}
const unlock = await instanceLock(join(statePath, 'instance.lock'));
const store = new Store(join(statePath, 'rootlane.sqlite'));
const host = new LinuxHost(); const lifecycle = new Lifecycle(config, store, host);
try { await lifecycle.reconcile(); } catch { console.error('Host reconciliation unavailable; catalog remains available and lifecycle mutations are blocked until a successful restart.'); }
const app = await createServer(config, new Rootlane(new Catalog(config, host, store), lifecycle), { owner: (await privateFile(ownerPath)).trim(), agent: (await privateFile(agentPath)).trim() }, join(dirname(fileURLToPath(import.meta.url)), 'web'));
await app.listen({ host: '127.0.0.1', port: config.port });
let closing = false;
async function shutdown() {
  if (closing) return; closing = true;
  await app.close(); await lifecycle.drain(); store.close(); unlock();
}
process.on('SIGTERM', () => { void shutdown(); }); process.on('SIGINT', () => { void shutdown(); });
