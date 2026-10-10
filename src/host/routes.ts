import { request } from 'node:http';
import { Problem } from '../shared/contracts.js';
import type { Host, Preview } from './types.js';

const queues = new WeakMap<Host, Promise<unknown>>();
export function routeLock<T>(host: Host, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(host) ?? Promise.resolve()).then(work);
  queues.set(
    host,
    next.catch(() => undefined),
  );
  return next;
}
export type ServeConfig = {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
  [key: string]: unknown;
};
export function routeState(raw: unknown, route: Preview): 'absent' | 'matching' | 'conflict' {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Problem('ROUTE_CONFIG', 'Unrecognized Serve configuration');
  const config = raw as ServeConfig;
  if (Object.values(config.Foreground ?? {}).some((c) => routeState(c, route) !== 'absent')) return 'conflict';
  const key = `${route.hostname}:${route.port}`;
  const web = Object.entries(config.Web ?? {}).filter(([name]) => name.endsWith(`:${route.port}`));
  const tcp = config.TCP?.[String(route.port)];
  const funnel = Object.entries(config.AllowFunnel ?? {}).some(([name, enabled]) => name.endsWith(`:${route.port}`) && enabled);
  if (!web.length && !tcp && !funnel) return 'absent';
  const handlers = config.Web?.[key]?.Handlers;
  const httpsOnly = tcp && typeof tcp === 'object' && (tcp as Record<string, unknown>).HTTPS === true && Object.keys(tcp).length === 1;
  return web.length === 1 &&
    Object.keys(config.Web![key] ?? {}).length === 1 &&
    httpsOnly &&
    !funnel &&
    handlers &&
    Object.keys(handlers).length === 1 &&
    handlers['/']?.Proxy === route.upstream &&
    Object.keys(handlers['/']).length === 1
    ? 'matching'
    : 'conflict';
}
export class ServeRoutes {
  constructor(readonly socketPath = '/run/tailscale/tailscaled.sock') {}
  private call(method: 'GET' | 'POST', config?: ServeConfig, etag?: string): Promise<{ config: ServeConfig; etag: string | null }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path: '/localapi/v0/serve-config',
          method,
          headers: {
            host: 'local-tailscaled.sock',
            ...(etag ? { 'if-match': etag } : {}),
            ...(config ? { 'content-type': 'application/json' } : {}),
          },
        },
        (response) => {
          const parts: Buffer[] = [];
          let bytes = 0;
          response.on('data', (part: Buffer) => {
            bytes += part.length;
            if (bytes > 256 * 1024) req.destroy(new Problem('OUTPUT_LIMIT', 'Serve configuration exceeds 256 KiB'));
            else parts.push(part);
          });
          response.on('error', reject);
          response.on('end', () => {
            if (response.statusCode === 412)
              return reject(new Problem('ROUTE_CHANGED', 'Serve configuration changed concurrently; inspect before retrying'));
            if (response.statusCode !== 200)
              return reject(
                new Problem(
                  'ROUTE_API_UNAVAILABLE',
                  `Guarded Serve ${method} returned HTTP ${response.statusCode}; check daemon support and operator permission`,
                ),
              );
            try {
              const value = method === 'GET' ? (JSON.parse(Buffer.concat(parts).toString('utf8')) ?? {}) : {};
              if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration');
              resolve({ config: value, etag: typeof response.headers.etag === 'string' ? response.headers.etag : null });
            } catch {
              reject(new Problem('ROUTE_CONFIG', 'Unrecognized Serve configuration'));
            }
          });
        },
      );
      const timer = setTimeout(() => req.destroy(new Problem('ROUTE_TIMEOUT', 'Guarded Serve request timed out')), 5000);
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end(config ? JSON.stringify(config) : undefined);
    });
  }
  async read() {
    return (await this.call('GET')).config;
  }
  async guarded() {
    return !!(await this.call('GET')).etag;
  }
  async change(route: Preview, remove: boolean) {
    const { config, etag } = await this.call('GET');
    if (!etag) throw new Problem('GUARDED_WRITES_UNAVAILABLE', 'Daemon omitted ETag; update Tailscale before changing routes');
    const state = routeState(config, route);
    if (remove && state === 'absent') return;
    if (state !== (remove ? 'matching' : 'absent'))
      throw new Problem(remove ? 'OWNERSHIP_CONFLICT' : 'ROUTE_CONFLICT', `HTTPS port ${route.port} is already configured or ownership changed`);
    const key = `${route.hostname}:${route.port}`;
    if (remove) {
      delete config.TCP?.[String(route.port)];
      delete config.Web?.[key];
    } else {
      (config.TCP ??= {})[String(route.port)] = { HTTPS: true };
      (config.Web ??= {})[key] = { Handlers: { '/': { Proxy: route.upstream } } };
    }
    await this.call('POST', config, etag);
    if (routeState(await this.read(), route) !== (remove ? 'absent' : 'matching'))
      throw new Problem('ROUTE_VERIFY_FAILED', 'Serve route change could not be verified; reservation retained');
  }
}
