import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
export async function procText(path: string, limit = 8192) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error('Process metadata limit');
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await file.close();
  }
}
export function processStat(text: string) {
  const fields = text
    .slice(text.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  return /^\d+$/.test(fields[19] ?? '') ? { ticks: Number(fields[19]), ppid: Number(fields[1]) } : null;
}
let ticks: Promise<number> | undefined;
export async function processClock(procRoot = '/proc') {
  try {
    // Lazy: host-side telemetry hooks import this file without node_modules (command.js pulls zod).
    ticks ??= import('./command.js').then(({ command }) => command('getconf', ['CLK_TCK'], { timeout: 1000 })).then(Number);
    const hz = await ticks;
    const stat = await procText(join(procRoot, 'stat'), 65536);
    const boot = Number(stat.match(/^btime (\d+)$/m)?.[1]);
    return hz > 0 && Number.isFinite(boot) ? { hz, boot } : null;
  } catch {
    return null;
  }
}
export const startedAt = (ticks: number, clock: { hz: number; boot: number } | null) =>
  clock ? new Date((clock.boot + ticks / clock.hz) * 1000).toISOString() : undefined;

// Only basenames leave the host; command values and full argv remain private.
export function serviceName(_comm: string, argv: string[]): string {
  const base = (value: string) => value.split('/').at(-1)!.replace(/[^\w.-]/g, '');
  const executable = base(argv[0] || '');
  const args: string[] = [], firstArgs: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (/^(--import|--require|-r|--loader|--eval|-e|--print|-p|-c|--inspect-port|--experimental-loader|--experimental-default-type|--experimental-specifier-resolution|--experimental-policy|--experimental-config-file)$/.test(arg)) { i++; continue; }
    if (/^--inspect(?:-brk|-wait)?$/.test(arg) && /^(?:[\w.[\]-]+:)?\d+$/.test(argv[i + 1] ?? '')) { i++; continue; }
    if (/^(--experimental-|--inspect|--enable-source-maps)/.test(arg) || arg.startsWith('-')) continue;
    args.push(arg);
    if (i < 8) firstArgs.push(arg);
  }
  if (['npm', 'pnpm', 'yarn'].includes(executable) && args[0] === 'run' && args[1])
    return `npm run ${base(args[1])}`.slice(0, 80);
  const entry = [argv[0], ...firstArgs].join(' ');
  for (const [pattern, name] of [
    [/\bvite(?:\/|\b)/, 'vite'], [/\bnext(?:\/|\b)/, 'next'], [/\bnuxt(?:\/|\b)/, 'nuxt'],
    [/\bastro(?:\/|\b)/, 'astro'], [/webpack-dev-server/, 'webpack-dev-server'],
    [/\buvicorn\b/, 'uvicorn'], [/\bgunicorn\b/, 'gunicorn'], [/\bflask\b/, 'flask'],
    [/\b(?:django|manage\.py)\b.*\brunserver\b/, 'django runserver'], [/\brails\b/, 'rails'],
    [/\bcargo\b.*\brun\b/, 'cargo run'], [/\bgo\b.*\brun\b/, 'go run'],
  ] as const) if (pattern.test(entry)) return name;
  if (/^python(?:\d(?:\.\d+)?)?$/.test(executable) && argv[1] === '-m' && /^[a-zA-Z_][\w.]*$/.test(argv[2] ?? ''))
    return `python -m ${argv[2]}`.slice(0, 80);
  const runner = executable === 'npx' ? base(args.shift() || '')
    : executable === 'pnpm' && args[0] === 'exec' ? (args.shift(), base(args.shift() || '')) : executable;
  if (['tsx', 'ts-node', 'bun', 'deno'].includes(runner) && ['run', 'watch'].includes(args[0])) args.shift();
  const script = ['node', 'tsx', 'ts-node', 'bun', 'deno', 'ruby'].includes(runner) || /^python(?:\d(?:\.\d+)?)?$/.test(runner) ? args[0] : undefined;
  return `${runner || '—'}${script ? ' ' + base(script) : ''}`.slice(0, 80);
}

export async function listenerOwner(pid: number | null, agents: { pid?: number; name: string }[], procRoot = '/proc', uid = process.getuid!()): Promise<{ owner?: 'agent'; startedBy?: { name: string; pid: number } }> {
  const seen = new Set<number>();
  for (let hop = 0; pid && hop <= 16 && !seen.has(pid); hop++) {
    seen.add(pid);
    try {
      const path = join(procRoot, String(pid));
      if ((await stat(path)).uid !== uid) return {};
      const before = processStat(await procText(join(path, 'stat')));
      if (!before) return {};
      const agent = agents.find(a => a.pid === pid);
      const after = processStat(await procText(join(path, 'stat')));
      if (before.ticks !== after?.ticks || (await stat(path)).uid !== uid) return {};
      if (agent) return hop === 0 ? { owner: 'agent' } : { startedBy: { name: agent.name, pid } };
      pid = before.ppid;
    } catch { return {}; }
  }
  return {};
}
