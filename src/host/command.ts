import { execFile } from 'node:child_process';
import { Problem } from '../shared/contracts.js';
export function command(file: string, args: string[], options: { cwd?: string; maxBuffer?: number; timeout?: number; allowedExitCodes?: number[] } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024, ...options, env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }, (error, stdout) => {
      if (error && !options.allowedExitCodes?.includes(Number(error.code))) reject(new Problem('HOST_COMMAND_FAILED', `${file} failed (${error.code ?? 'timeout/output limit'}); check host permissions and capabilities`));
      else resolve(stdout);
    });
  });
}
