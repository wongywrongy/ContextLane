import { loadConfig } from '../config.js';
import { LinuxHost } from './linux.js';
import { Problem } from '../shared/contracts.js';
import { preflightPorts } from './preflight-ports.js';
const path = process.env.ROOTLANE_CONFIG;
if (!path) throw new Error('ROOTLANE_CONFIG is required');
const config = await loadConfig(path);
const host = new LinuxHost();
await host.capabilities(config.profiles.flatMap((p) => p.services));
const connection = await host.connection();
if (connection.status !== 'connected' || connection.hostname !== config.tailnetHostname)
  throw new Problem('MISSING_CAPABILITY', 'Configured Tailscale hostname is not connected');
const listeners = await host.listeners();
const routes = await host.routes();
const ports = preflightPorts(config, process.env.ROOTLANE_PREFLIGHT_RUNNING === '1');
for (const port of ports) {
  if (listeners.some((l) => l.port === port)) throw new Problem('PORT_CONFLICT', `TCP port ${port} is already bound`);
  if (host.routeState(routes, { hostname: config.tailnetHostname, port, upstream: 'http://127.0.0.1:1', label: 'preflight' }) !== 'absent')
    throw new Problem('ROUTE_CONFLICT', `Serve port ${port} is already configured`);
}
console.info(
  JSON.stringify({
    checkedAt: new Date().toISOString(),
    hostname: connection.hostname,
    unusedPorts: ports,
    note: 'Read-only preflight passed. Ports can still race; no units or routes were created and preview access is not yet verified.',
  }),
);
