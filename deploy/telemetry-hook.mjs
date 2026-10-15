import { readFileSync, readlinkSync, mkdirSync, statSync, lstatSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request } from 'node:http';

export function ingestSettings(env = process.env) {
  const fallback = {};
  if (!env.ROOTLANE_TELEMETRY_URL || !env.ROOTLANE_INGEST_TOKEN) {
    try {
      for (const line of readFileSync(join(homedir(), '.config/rootlane/ingest.env'), 'utf8').split('\n')) {
        const match = /^(?:export )?(ROOTLANE_TELEMETRY_URL|ROOTLANE_INGEST_TOKEN)=(.*)$/.exec(line);
        if (match) fallback[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    } catch {}
  }
  const endpoint = new URL(env.ROOTLANE_TELEMETRY_URL ?? fallback.ROOTLANE_TELEMETRY_URL ?? 'http://127.0.0.1:9481');
  const token = env.ROOTLANE_INGEST_TOKEN ?? fallback.ROOTLANE_INGEST_TOKEN;
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || typeof token !== 'string' || token.length < 32 || token.length > 256 || /[\r\n]/.test(token)) throw new Error('Invalid loopback ingest configuration');
  return { endpoint, token };
}

export async function findClaudePid(procRoot = '/proc', parentPid = process.ppid) {
  const [{ agentName }, { processStat }] = await Promise.all([import('../dist/host/agents.js'), import('../dist/host/process.js')]);
  let pid = parentPid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const directory = join(procRoot, String(pid));
    try {
      const state = processStat(readFileSync(join(directory, 'stat'), 'utf8'));
      if (!state) return null;
      const executable = readlinkSync(join(directory, 'exe'));
      const argv = readFileSync(join(directory, 'cmdline'), 'utf8').split('\0');
      if (agentName(executable, argv) === 'Claude Code') return pid;
      pid = state.ppid;
    } catch { return null; }
  }
  return null;
}

export function post(path, body) {
  return new Promise(resolve => {
    try {
      const { endpoint, token } = ingestSettings();
      const payload = JSON.stringify(body);
      const outgoing = request(new URL(path, endpoint), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => { response.resume(); response.on('end', resolve); });
      const timer = setTimeout(() => { outgoing.destroy(); resolve(); }, 300);
      outgoing.on('error', resolve);
      outgoing.on('close', () => clearTimeout(timer));
      outgoing.end(payload);
    } catch { resolve(); }
  });
}

const numbers = (value, keys) => Object.fromEntries(keys.flatMap(key => Number.isFinite(value?.[key]) && value[key] >= 0 ? [[key, value[key]]] : []));
export function statuslineSnapshot(input) {
  if (typeof input?.session_id !== 'string' || !input.session_id || input.session_id.length > 200) return null;
  return {
    session_id: input.session_id,
    model: Object.fromEntries(['id', 'display_name'].flatMap(key => typeof input.model?.[key] === 'string' ? [[key, input.model[key].slice(0, 160)]] : [])),
    context_window: numbers(input.context_window, ['used_percentage', 'context_window_size']),
    current_usage: numbers(input.context_window?.current_usage, ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']),
    rate_limits: Object.fromEntries(['five_hour', 'seven_day'].flatMap(key => input.rate_limits?.[key] ? [[key, numbers(input.rate_limits[key], ['used_percentage', 'resets_at'])]] : [])),
    ...(typeof input.exceeds_200k_tokens === 'boolean' ? { exceeds_200k_tokens: input.exceeds_200k_tokens } : {}),
    cost: numbers(input.cost, ['total_cost_usd']),
  };
}

export function claimStatusline(sessionId, directory = join(homedir(), '.cache/rootlane/statusline'), now = Date.now()) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077) return false;
    const path = join(directory, createHash('sha256').update(sessionId).digest('hex'));
    try {
      if (now - statSync(path).mtimeMs < 5000) return false;
      unlinkSync(path);
    } catch (error) { if (error.code !== 'ENOENT') return false; }
    closeSync(openSync(path, 'wx', 0o600));
    return true;
  } catch { return false; }
}

export async function stdinBytes() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}
