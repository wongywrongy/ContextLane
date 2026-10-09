#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from './server.js';
const base = process.env.ROOTLANE_URL ?? 'http://127.0.0.1:9480';
const token = process.env.ROOTLANE_AGENT_TOKEN;
if (!token) { console.error('ROOTLANE_AGENT_TOKEN is required in the adapter launch environment'); process.exit(1); }
const handle = serveStdio(() => createMcpServer(base, token));
process.on('SIGINT', () => { void handle.close(); });
process.on('SIGTERM', () => { void handle.close(); });
