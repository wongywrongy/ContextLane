import type { Config } from '../config.js';

export function preflightPorts(config: Pick<Config, 'port' | 'origin' | 'profiles'>, running: boolean): number[] {
  // Installed preflight must not treat Rootlane's own API and operator route as conflicts.
  return [...(running ? [] : [config.port, Number(new URL(config.origin).port || 443)]), ...config.profiles.flatMap(p => [...p.services.map(s => s.port), ...p.previews.map(r => r.httpsPort)])];
}
