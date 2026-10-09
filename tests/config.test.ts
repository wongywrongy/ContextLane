import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { setup } from './helpers.js';
test('configuration is private, outside observation roots, and rejects duplicate or infrastructure ports', async t => {
  const { config, root } = await setup(t); const projects = join(root, 'projects'); await mkdir(projects);
  config.projectRoots = [projects]; config.observationRoots = [projects]; config.profiles[0].projectPath = projects;
  for (const service of config.profiles[0].services) service.cwd = projects;
  const path = join(root, 'config.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 }); assert.equal((await loadConfig(path)).profiles.length, 1);
  await chmod(path, 0o644); await assert.rejects(() => loadConfig(path), /mode 0600/); await chmod(path, 0o600);
  config.profiles[0].services[0].port = 19483; await writeFile(path, JSON.stringify(config)); await assert.rejects(() => loadConfig(path), /Application port/);
  config.profiles[0].services[0].port = 19481; config.profiles[0].previews[0].httpsPort = 19482;
  await writeFile(path, JSON.stringify(config)); await assert.rejects(() => loadConfig(path), /reserved preview port/);
  const unsafe = join(projects, 'config.json'); await writeFile(unsafe, JSON.stringify(config), { mode: 0o600 }); await assert.rejects(() => loadConfig(unsafe), /outside observation roots/);
});
