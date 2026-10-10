import { loadConfig, inside, type Config } from './config.js';
import { Problem, problem } from './shared/contracts.js';
import type { Rootlane } from './service.js';

export async function reloadConfig(path: string, config: Config, service: Rootlane, privatePaths: string[]) {
  try {
    const next = await loadConfig(path);
    for (const key of ['stateDirectory', 'port', 'origin', 'additionalOrigins', 'tailnetHostname'] as const)
      if (JSON.stringify(next[key]) !== JSON.stringify(config[key])) throw new Problem('CONFIG_RESTART_REQUIRED', `${key} changes require a restart`);
    for (const privatePath of privatePaths)
      if (next.observationRoots.some(root => inside(privatePath, root))) throw new Problem('CONFIG_LOCATION', 'Private configuration, credentials and state must stay outside observation roots');
    Object.assign(config, next);
    for (const profile of config.profiles) service.lifecycle.store.ensure(profile);
    service.catalog.invalidate(); service.configError = null;
  } catch (error) {
    service.configError = error instanceof Problem ? problem(error) : { code: 'INVALID_CONFIG', message: 'Configuration validation failed; the previous configuration remains active' };
  }
}
export function reconcileWithRetry(service: Rootlane, schedule = (work: () => void, ms: number) => setTimeout(work, ms)) {
  let timer: ReturnType<typeof setTimeout> | undefined; let retryMs = 2000; let stopped = false;
  async function run() {
    try {
      if (!service.lifecycle.available) await service.lifecycle.reconcile();
      if (!service.publications.available) await service.publications.reconcile();
      service.lastError = null; retryMs = 2000;
    } catch (error) {
      service.lastError = problem(error);
      if (!stopped) timer = schedule(() => { void run(); }, retryMs);
      retryMs = Math.min(60000, retryMs * 2);
    }
  }
  return { run, stop() { stopped = true; clearTimeout(timer); } };
}
