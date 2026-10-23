import { opendir, stat, readlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { procText, processStat, processClock, startedAt } from './process.js';
import type { AgentObservation } from './types.js';

export function agentName(executable: string, argv: string[] = []): 'Codex' | 'Claude Code' | null {
  const path = executable.replace(/ \(deleted\)$/, '');
  if (basename(path) === 'codex') return 'Codex';
  if (basename(path) === 'claude' || /\/\.local\/share\/claude\/versions\/\d+\.\d+\.\d+$/.test(path)) return 'Claude Code';
  if (['node', 'bun'].includes(basename(path))) {
    if (argv.some((a) => /\/@anthropic-ai\/claude-code\/(?:cli\.js|bin\/claude\.js)$/.test(a))) return 'Claude Code';
    if (argv.some((a) => /\/@openai\/codex\/bin\/codex\.js$/.test(a))) return 'Codex';
  }
  return null;
}

export async function observeAgents(procRoot = '/proc', uid = process.getuid!()): Promise<{ agents: AgentObservation[]; warnings: string[] }> {
  const agents: (AgentObservation & { ppid: number })[] = [];
  const clock = await processClock(procRoot);
  const warnings: string[] = [];
  const deadline = Date.now() + 2000;
  let entries = 0;
  let denied = 0;
  const directory = await opendir(procRoot);
  for await (const entry of directory) {
    if (!/^\d+$/.test(entry.name)) continue;
    if (Date.now() >= deadline || agents.length >= 128) {
      warnings.push('Agent detection limited; some processes may be missing');
      break;
    }
    const path = join(procRoot, entry.name);
    try {
      if ((await stat(path)).uid !== uid) continue;
      // Other users' containers must not exhaust this owner's observation budget.
      if (++entries > 8192) {
        warnings.push('Agent detection limited; some processes may be missing');
        break;
      }
      const before = processStat(await procText(join(path, 'stat')));
      if (!before) continue;
      const exe = await readlink(join(path, 'exe'));
      const argv = ['node', 'bun'].includes(basename(exe)) ? (await procText(join(path, 'cmdline'), 16384)).split('\0') : [];
      const name = agentName(exe, argv);
      if (!name) continue;
      const cwd = await readlink(join(path, 'cwd'));
      const after = processStat(await procText(join(path, 'stat')));
      if (before.ticks !== after?.ticks || (await stat(path)).uid !== uid) continue;
      agents.push({
        id: createHash('sha256').update(`${entry.name}:${before.ticks}`).digest('hex').slice(0, 24),
        name,
        cwd,
        pid: Number(entry.name),
        ppid: before.ppid,
        ...(startedAt(before.ticks, clock) ? { startedAt: startedAt(before.ticks, clock) } : {}),
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') denied++;
      else if (code && code !== 'ENOENT' && code !== 'ESRCH') throw error;
    }
  }
  if (denied) warnings.push('Agent detection incomplete; some same-user process metadata is inaccessible');
  return {
    agents: agents.filter((a) => !agents.some((parent) => parent.pid === a.ppid && parent.name === a.name)).map(({ ppid, ...a }) => a),
    warnings,
  };
}
