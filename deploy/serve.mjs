#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { LinuxHost } from '../dist/host/linux.js';
const config = JSON.parse(await readFile(process.env.ROOTLANE_CONFIG, 'utf8'));
const token = (await readFile(process.env.ROOTLANE_AGENT_CREDENTIAL_FILE, 'utf8')).trim();
const response = await fetch(`http://127.0.0.1:${config.port}/api/status`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
if (!response.ok || !(await response.json()).connected) throw new Error('The configured authenticated Rootlane backend must be running first');
const route = { hostname: config.tailnetHostname, port: Number(new URL(config.origin).port || 443), upstream: `http://127.0.0.1:${config.port}`, label: 'Rootlane' };
const host = new LinuxHost();
const state = host.routeState(await host.routes(), route);
if (state === 'conflict') throw new Error(`HTTPS ${route.port} is occupied; existing configuration was preserved`);
if (state === 'absent') await host.addRoute(route);
console.log(config.origin);
