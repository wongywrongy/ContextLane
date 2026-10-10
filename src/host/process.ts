import { open } from 'node:fs/promises';
import { command } from './command.js';
import { join } from 'node:path';
export async function procText(path: string, limit = 8192) {
  const file = await open(path, 'r');
  try { const buffer = Buffer.alloc(limit + 1); const {bytesRead} = await file.read(buffer, 0, buffer.length, 0); if (bytesRead > limit) throw new Error('Process metadata limit'); return buffer.toString('utf8', 0, bytesRead); }
  finally { await file.close(); }
}
export function processStat(text: string) {
  const fields = text.slice(text.lastIndexOf(')')+2).trim().split(/\s+/);
  return /^\d+$/.test(fields[19] ?? '') ? {ticks:Number(fields[19]), ppid:Number(fields[1])} : null;
}
let ticks: Promise<number> | undefined;
export async function processClock(procRoot = '/proc') {
  try {
    ticks ??= command('getconf', ['CLK_TCK'], {timeout:1000}).then(Number);
    const hz = await ticks; const stat = await procText(join(procRoot, 'stat'), 65536);
    const boot = Number(stat.match(/^btime (\d+)$/m)?.[1]);
    return hz > 0 && Number.isFinite(boot) ? { hz, boot } : null;
  } catch { return null; }
}
export const startedAt = (ticks: number, clock: {hz:number;boot:number} | null) => clock ? new Date((clock.boot + ticks/clock.hz)*1000).toISOString() : undefined;
