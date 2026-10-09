import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: '/tmp/rootlane-disposable-vite-cache',
  server: { host: '127.0.0.1', port: 19482, strictPort: true, allowedHosts: ['neo.taile1abc7.ts.net'], hmr: { protocol: 'wss', host: 'neo.taile1abc7.ts.net', clientPort: 19484 }, proxy: { '/api': 'http://127.0.0.1:19481' } }
});
