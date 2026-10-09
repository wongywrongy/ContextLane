import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const { tailnetHostname } = JSON.parse(readFileSync(process.env.ROOTLANE_CONFIG ?? join(homedir(), '.config/rootlane/config.json'), 'utf8'));
if (typeof tailnetHostname !== 'string' || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(tailnetHostname)) throw new Error('Fixture requires the owner-configured Tailscale hostname');
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: '/tmp/rootlane-disposable-vite-cache',
  server: { host: '127.0.0.1', port: 19482, strictPort: true, allowedHosts: [tailnetHostname], hmr: { protocol: 'wss', host: tailnetHostname, clientPort: 19484 }, proxy: { '/api': 'http://127.0.0.1:19481' } }
});
