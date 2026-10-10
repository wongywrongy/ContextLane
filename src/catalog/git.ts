import { command } from '../host/command.js';
import { procText } from '../host/process.js';
import { join } from 'node:path';
import type { Project } from '../shared/contracts.js';
export async function worktreeState(path: string): Promise<NonNullable<Project['git']>> {
  const state: NonNullable<Project['git']> = { dirty: null, ahead: null, behind: null, lastCommit: null };
  const git = (args: string[]) => command('git', ['-C', path, ...args], { timeout: 1000, maxBuffer: 65536 });
  await Promise.allSettled([
    git(['status', '--porcelain=v1', '-z', '--untracked-files=normal']).then((text) => {
      const fields = text.split('\0');
      let count = 0;
      for (let i = 0; i < fields.length; i++)
        if (fields[i]) {
          count++;
          if (/^[RC]|^.[RC]/.test(fields[i])) i++;
        }
      state.dirty = Math.min(count, 1000);
    }),
    git(['rev-list', '--left-right', '--count', '@{u}...HEAD']).then((text) => {
      const match = text.trim().match(/^(\d+)\s+(\d+)$/);
      if (match) {
        state.behind = Number(match[1]);
        state.ahead = Number(match[2]);
      }
    }),
    git(['log', '-1', '--format=%h%x00%s%x00%cI', '--abbrev=7']).then((text) => {
      const [sha7, subject, committedAt] = text.trim().split('\0');
      if (/^[a-f0-9]{7}$/.test(sha7) && Number.isFinite(Date.parse(committedAt)))
        state.lastCommit = { sha7, subject: subject.slice(0, 120), committedAt };
    }),
  ]);
  return state;
}
export async function devCommand(path: string): Promise<Project['devCommand']> {
  try {
    const value = JSON.parse(await procText(join(path, 'package.json'), 65536));
    const command = value.scripts?.dev;
    // Recognize only literal dev commands; discovery never executes package scripts.
    const match = typeof command === 'string' ? command.match(/^(vite|next dev|nuxt dev|astro dev|webpack serve)(?: --host 127\.0\.0\.1)?$/) : null;
    return match ? (match[1] as Project['devCommand']) : undefined;
  } catch {
    return undefined;
  }
}
