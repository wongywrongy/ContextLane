import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["source"] },
  server: { proxy: { "/api": "http://127.0.0.1:4600" } },
  build: { outDir: "dist", sourcemap: true },
});
