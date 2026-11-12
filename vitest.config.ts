import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// One test run for the whole repo. Workspace packages resolve to their TypeScript source,
// Most tests run from source; the CodeGraph integration test also exercises its built worker.
export default defineConfig({
  resolve: {
    alias: {
      "@contextlanes/lanehost/usage": src("./apps/lanehost/src/usage.ts"),
      "@contextlanes/protocol": src("./packages/protocol/src/index.ts"),
      "@contextlanes/toolbox": src("./packages/toolbox/src/index.ts"),
      "@contextlanes/daemon": src("./apps/daemon/src/index.ts"),
      "@contextlanes/lanehost": src("./apps/lanehost/src/index.ts"),
      "@contextlanes/cli": src("./apps/cli/src/index.ts"),
    },
  },
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
