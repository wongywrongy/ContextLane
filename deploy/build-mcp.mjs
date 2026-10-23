import { build } from 'esbuild';
import { resolve } from 'node:path';

await build({
  entryPoints: ['src/mcp/main.ts'],
  outfile: 'dist/mcp/standalone.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  // Preserve Zod's initialization order across the SDK's zod/v4 and our zod imports.
  alias: { zod: resolve('node_modules/zod/index.cjs'), 'zod/v4': resolve('node_modules/zod/v4/index.cjs') },
});
