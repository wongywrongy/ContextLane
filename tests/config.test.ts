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

test('independent target paths and operator/infrastructure ports must be reviewed', async t => {
  const { config, root } = await setup(t); const projects=join(root,'projects'); await mkdir(projects);
  config.projectRoots=[projects];config.observationRoots=[projects];config.profiles=[];
  const target={id:'web',approved:true as const,projectPath:projects,checkoutPath:projects,serviceId:'web',serviceName:'Web',port:19482,httpsPort:19485,readiness:{path:'/',status:200,bodyIncludes:'fixture',timeoutMs:100}};
  config.previewTargets=[target];const path=join(root,'config.json');const save=()=>writeFile(path,JSON.stringify(config),{mode:0o600});
  await save();assert.equal((await loadConfig(path)).previewTargets.length,1);
  target.checkoutPath='/tmp';await save();await assert.rejects(loadConfig(path),/observation roots/);
  target.checkoutPath=projects;target.httpsPort=19483;await save();await assert.rejects(loadConfig(path),/reserved/);
  target.httpsPort=19485;config.additionalOrigins=['https://alias.example:19485'];await save();await assert.rejects(loadConfig(path),/reserved/);
});
