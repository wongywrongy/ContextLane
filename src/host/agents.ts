import { opendir, stat, readFile, readlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentObservation } from './types.js';

export function agentName(executable: string): 'Codex' | 'Claude Code' | null {
  const path = executable.replace(/ \(deleted\)$/, '');
  if (basename(path) === 'codex') return 'Codex';
  if (basename(path) === 'claude' || /\/\.local\/share\/claude\/versions\/\d+\.\d+\.\d+$/.test(path)) return 'Claude Code';
  return null;
}

function identity(metadata: string): string | null {
  const fields = metadata.slice(metadata.lastIndexOf(')') + 2).trim().split(/\s+/);
  return /^\d+$/.test(fields[19] ?? '') ? fields[19] : null;
}

export async function observeAgents(procRoot = '/proc', uid = process.getuid!()): Promise<{ agents: AgentObservation[]; warnings: string[] }> {
  const agents: AgentObservation[] = []; const warnings: string[] = [];
  const deadline = Date.now() + 2000; let entries = 0; let denied = 0;
  const directory = await opendir(procRoot);
  for await (const entry of directory) {
    if (!/^\d+$/.test(entry.name)) continue;
    if (++entries > 8192 || Date.now() >= deadline || agents.length >= 128) { warnings.push('Agent detection limited; some processes may be missing'); break; }
    const path = join(procRoot, entry.name);
    try {
      if ((await stat(path)).uid !== uid) continue;
      const before = identity(await readFile(join(path, 'stat'), 'utf8'));
      if (!before) continue;
      const name = agentName(await readlink(join(path, 'exe')));
      if (!name) continue;
      const cwd = await readlink(join(path, 'cwd'));
      const after = identity(await readFile(join(path, 'stat'), 'utf8'));
      if (before !== after || (await stat(path)).uid !== uid) continue;
      agents.push({ id: createHash('sha256').update(`${entry.name}:${before}`).digest('hex').slice(0, 24), name, cwd });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') denied++;
      else if (code !== 'ENOENT' && code !== 'ESRCH') throw error;
    }
  }
  if (denied) warnings.push('Agent detection incomplete; some same-user process metadata is inaccessible');
  return { agents, warnings };
}
