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

export function serviceName(comm: string, argv: string[]): string {
  const entry = argv.slice(0,3).join(' ');
  for (const [pattern,name] of [
    [/\b(?:vite)(?:\/|\b)/,'vite'],[/\bnext(?:\/|\b)/,'next'],[/\bnuxt(?:\/|\b)/,'nuxt'],[/\bastro(?:\/|\b)/,'astro'],[/webpack-dev-server/,'webpack-dev-server'],
    [/\buvicorn\b/,'uvicorn'],[/\bgunicorn\b/,'gunicorn'],[/\bflask\b/,'flask'],[/\b(?:django|manage\.py)\b.*\brunserver\b/,'django runserver'],[/\brails\b/,'rails'],[/\bcargo\b.*\brun\b/,'cargo run'],[/\bgo\b.*\brun\b/,'go run']
  ] as const) if (pattern.test(entry)) return name;
  const executable = argv[0]?.split('/').at(-1);
  if (/^python(?:\d(?:\.\d+)?)?$/.test(executable ?? '') && argv[1] === '-m' && /^[a-zA-Z_][\w.]{0,80}$/.test(argv[2] ?? '')) return `python -m ${argv[2]}`;
  if (executable === 'node' && /\.(?:[cm]?js|ts)$/.test(argv[1] ?? '')) return `node ${argv[1]!.split('/').at(-1)!.replace(/[^\w.-]/g,'').slice(0,80)}`;
  return comm.trim().replace(/[^\w .-]/g,'').slice(0,100) || '—';
}
