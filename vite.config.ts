import { defineConfig } from 'vite';
export default defineConfig({ root: 'web', build: { assetsInlineLimit: 0, outDir: '../dist/web', emptyOutDir: true } });
