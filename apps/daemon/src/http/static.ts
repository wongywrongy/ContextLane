import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
export function serveWeb(app: FastifyInstance, directory = fileURLToPath(new URL("../../../web/dist", import.meta.url))): void {
  app.setNotFoundHandler(async (req, reply) => {
    if (!["GET", "HEAD"].includes(req.method) || req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    let path: string;
    try { path = decodeURIComponent(req.url.split("?")[0]!); } catch { return reply.code(400).send({ error: "invalid path" }); }
    const root = resolve(directory);
    const target = resolve(root, `.${path}`);
    if (target !== root && !target.startsWith(root + sep)) return reply.code(403).send({ error: "invalid path" });
    const file = extname(target) ? target : resolve(root, "index.html");
    try {
      if (!(await stat(file)).isFile()) throw new Error("not a file");
      return reply.header("cache-control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache").type(mime[extname(file)] ?? "application/octet-stream").send(await readFile(file));
    } catch { return reply.code(404).send({ error: "Web app is missing; run pnpm build" }); }
  });
}
