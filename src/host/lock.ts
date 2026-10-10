import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Problem } from '../shared/contracts.js';
export async function instanceLock(path: string): Promise<() => void> {
  const fd = openSync(path, 'a', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      // flock locks the shared open-file description; this parent keeps it alive.
      const child = spawn('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Problem('INSTANCE_RUNNING', 'Another Rootlane instance holds the state lock')),
      );
    });
    return () => closeSync(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
