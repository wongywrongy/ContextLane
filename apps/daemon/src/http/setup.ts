import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SetupManager } from "../setup.js";
import { SetupError } from "../setup.js";

export function requestOrigin(req: FastifyRequest): string {
  const login = req.headers["tailscale-user-login"];
  const origin = req.headers.origin ?? `${typeof login === "string" ? "https" : "http"}://${req.headers.host}`;
  let url: URL;
  try { url = new URL(origin); } catch { throw new SetupError("Invalid origin", 403); }
  if (url.host !== req.headers.host || !["http:", "https:"].includes(url.protocol) ||
    (!["localhost", "127.0.0.1"].includes(url.hostname) && typeof login !== "string")) throw new SetupError("Open this page from ContextLanes", 403);
  return url.origin;
}

export function setupRoutes(app: FastifyInstance, setup: SetupManager): void {
  const session = (req: FastifyRequest, token: string) => `cl-owner=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${requestOrigin(req).startsWith("https:") ? "; Secure" : ""}`;
  app.get("/api/setup/status", async (req) => ({ claimed: setup.claimed, authorized: setup.authorized(req.headers["tailscale-user-login"], req.headers.cookie, req.hostname),
    hasPasskey: !!setup.config.access.passkey, tailnetLogin: typeof req.headers["tailscale-user-login"] === "string" ? req.headers["tailscale-user-login"] : null,
    publicUrl: setup.config.notifications.publicUrl ?? null, ...(!setup.claimed && !req.headers["tailscale-user-login"] ? { claimFile: setup.claimFile } : {}) }));
  app.post("/api/setup/claim/tailnet", async (req, reply) => {
    const token = await setup.claimTailnet(req.body, req.headers["tailscale-user-login"]);
    return reply.header("set-cookie", session(req, token)).send({ claimed: true });
  });
  app.post("/api/setup/claim/options", async (req) => setup.registration(req.body, requestOrigin(req)));
  app.post("/api/setup/claim/passkey", async (req, reply) => {
    const token = await setup.register(req.body, requestOrigin(req));
    return reply.header("set-cookie", session(req, token)).send({ claimed: true });
  });
  app.post("/api/setup/login/options", async (req) => setup.authentication(requestOrigin(req)));
  app.post("/api/setup/login", async (req, reply) => {
    const token = await setup.login(req.body, requestOrigin(req));
    return reply.header("set-cookie", session(req, token)).send({ authorized: true });
  });
  app.get("/api/setup/settings", async () => ({ host: setup.config.host, access: { owner: setup.config.access.owner },
    agents: setup.config.agents, notifications: setup.config.notifications, localModels: setup.config.localModels,
    lanes: { maxConcurrent: setup.config.lanes.maxConcurrent, launchHosts: setup.config.lanes.launchHosts } }));
  app.post("/api/setup/settings", async (req) => { await setup.settings(req.body); return { saved: true }; });
  app.get("/api/setup/agents", async () => setup.detectAgents());
  app.post("/api/setup/agents/install", async (req) => setup.installAgent(req.body));
  app.post("/api/setup/tailnet", async () => setup.enableTailnet());
  app.post("/api/setup/push", async () => setup.generatePush());
  app.post("/api/setup/model/probe", async (req) => setup.probeModel(req.body));
}
