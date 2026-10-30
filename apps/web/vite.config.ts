import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ["source"] },
  server: { host: "127.0.0.1", proxy: { "/api": { target: "http://127.0.0.1:4600", ws: true } } },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", sourcemap: true },
});
