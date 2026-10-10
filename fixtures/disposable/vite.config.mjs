import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const tailnetHostname=process.env.ROOTLANE_PREVIEW_ORIGIN?new URL(process.env.ROOTLANE_PREVIEW_ORIGIN).hostname:JSON.parse(readFileSync(process.env.ROOTLANE_CONFIG ?? join(homedir(), '.config/rootlane/config.json'), 'utf8')).tailnetHostname;
if (typeof tailnetHostname !== 'string' || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(tailnetHostname)) throw new Error('Fixture requires the owner-configured Tailscale hostname');
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: process.env.ROOTLANE_PREVIEW_PORT?`/tmp/rootlane-disposable-vite-${process.env.ROOTLANE_PREVIEW_PORT}`:'/tmp/rootlane-disposable-vite-cache',
  server: { host: '127.0.0.1', port: Number(process.env.ROOTLANE_PORT??19482), strictPort: true, allowedHosts: [tailnetHostname], hmr: { protocol: 'wss', host: tailnetHostname, clientPort: Number(process.env.ROOTLANE_PREVIEW_PORT??19484) }, proxy: { '/api': process.env.API_URL??'http://127.0.0.1:19481' } }
});
