import { GitHub } from "../github.js";
import { CloneRequest, RegistryInstall } from "@contextlanes/protocol";
import { AgentRegistry } from "../registry.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AgentId, FolderQuery, ProjectId, SignInRequest } from "@contextlanes/protocol";
import { z } from "zod";
import type { SetupManager } from "../setup.js";
import { SetupError } from "../setup.js";
import type { Store } from "../db/store.js";
import type { Runner } from "../run.js";
import { connectTerminal } from "../terminal/socket.js";
import type { Auth } from "./auth.js";

export function requestOrigin(req: FastifyRequest): string {
  const login = req.headers["tailscale-user-login"];
  const origin = req.headers.origin ?? `${typeof login === "string" ? "https" : "http"}://${req.headers.host}`;
  let url: URL;
  try { url = new URL(origin); } catch { throw new SetupError("Open this page from ContextLanes and try again.", 403); }
  if (url.host !== req.headers.host || !["http:", "https:"].includes(url.protocol) ||
    (!["localhost", "127.0.0.1"].includes(url.hostname) && typeof login !== "string")) throw new SetupError("Open this page from ContextLanes and try again.", 403);
  return url.origin;
}

const LocalSetupRequest = z.object({ sshHost: z.string().regex(/^[\w.:-]+$/).optional() });
export function setupRoutes(app: FastifyInstance, setup: SetupManager, store: Store, run: Runner, auth: Auth): void {
  app.get("/api/setup/status", async (req, reply) => {
    // Sessions used to be cookies, which every preview port received. The value is ignored; it only tells us to say why this browser was signed out.
    const signedOut = /(^|;\s*)cl-owner=/.test(req.headers.cookie ?? "");
    if (signedOut) void reply.header("set-cookie", "cl-owner=; Path=/; Max-Age=0");
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    return { claimed: setup.claimed, authorized: setup.claimed && !!bearer && await auth.owner(bearer), signedOut,
    hasPasskey: !!setup.config.access.passkey, tailnetLogin: typeof req.headers["tailscale-user-login"] === "string" ? req.headers["tailscale-user-login"] : null,
    publicUrl: setup.config.notifications.publicUrl ?? null, hasLane: store.hasStartedLane(),
    ...(!req.headers["tailscale-user-login"] && ["localhost", "127.0.0.1"].includes(req.hostname) ? { controlFile: setup.controlFile } : {}) };
  });
  app.post("/api/setup/local", async (req) => {
    if (req.headers.origin || req.headers["tailscale-user-login"] || !["127.0.0.1", "localhost"].includes(req.hostname) || !["127.0.0.1", "::1"].includes(req.ip)) throw new SetupError("Run contextlanes setup in this machine’s SSH session.", 403);
    await setup.checkShell(req.headers.authorization?.replace(/^Bearer /, ""));
    return setup.shellSetup(LocalSetupRequest.parse(req.body ?? {}).sshHost);
  });
  app.post("/api/setup/sign-in", async (req, reply) => {
    const token = setup.signIn(SignInRequest.parse(req.body).token, requestOrigin(req));
    return reply.header("cache-control", "no-store").send({ authorized: true, token });
  });
  app.post("/api/setup/passkey/options", async (req) => setup.registration(requestOrigin(req)));
  app.post("/api/setup/passkey", async (req, reply) => {
    const token = await setup.register(req.body, requestOrigin(req));
    return reply.header("cache-control", "no-store").send({ saved: true, token });
  });
  app.post("/api/setup/login/options", async (req) => setup.authentication(requestOrigin(req)));
  app.post("/api/setup/login", async (req, reply) => {
    const token = await setup.login(req.body, requestOrigin(req));
    return reply.header("cache-control", "no-store").send({ authorized: true, token });
  });
  app.get("/api/setup/settings", async () => setup.redactedSettings());
  app.post("/api/setup/settings", async (req) => { await setup.settings(req.body); return { saved: true }; });
  app.get("/api/setup/agents", async () => setup.detectAgents());
  app.post("/api/setup/agents/install", async (req) => setup.installAgent(req.body));
  app.register(async (terminal) => {
    terminal.get<{ Params: { agent: string } }>("/api/setup/agents/:agent/terminal", { websocket: true,
      preValidation: async (req) => { AgentId.parse(req.params.agent); if (req.headers.origin) requestOrigin(req); },
    }, (socket, req) => {
      // Install listeners before resolving the command, so early keystrokes are not lost.
      const messages: Parameters<typeof socket.emit>[] = [];
      const buffer = (...args: unknown[]) => { if (messages.length < 16) messages.push(["message", ...args]); else socket.close(1008, "Wait for the login terminal to connect, then retry."); };
      socket.on("message", buffer);
      void setup.loginCommand(req.params.agent).then(({ command, args, cwd }) => {
        socket.off("message", buffer);
        if (socket.readyState !== socket.OPEN) return;
        if (!run.terminal) throw new Error("PTY unavailable");
        connectTerminal(socket, run.terminal(command, args, { cwd, cols: 80, rows: 24 }));
        for (const message of messages) socket.emit(...message);
      }).catch(() => socket.close(1011, "Login terminal could not open; install the native terminal build and try again."));
    });
  });
  app.get("/api/setup/projects/scan", async () => setup.projects.scan());
  app.get("/api/setup/projects/folders", async (req) => setup.projects.folders(FolderQuery.parse(req.query).path));
  app.get<{ Params: { project: string } }>("/api/projects/:project/branches", async (req) => {
    const project = store.getProject(ProjectId.parse(req.params.project));
    if (!project) throw new SetupError("Add this project before choosing a branch.", 404);
    return setup.projects.branches(project.path);
  });
  const github = new GitHub(run, setup.config.paths.code);
  app.get("/api/setup/github", async () => github.list());
  app.post("/api/setup/github/clone", async (req) => setup.addProject({ path: await github.clone(CloneRequest.parse(req.body)) }));
  const registry = new AgentRegistry({ run });
  app.get("/api/setup/registry", async () => registry.list(setup.config.agents));
  app.post("/api/setup/registry/install", async (req) => setup.installFromRegistry(registry, RegistryInstall.parse(req.body).id));
  app.delete<{ Params: { id: string } }>("/api/setup/agents/:id", async (req) => { await setup.removeRegistryAgent(RegistryInstall.parse({ id: req.params.id }).id); return { removed: true }; });
  app.post("/api/setup/tailnet", async () => setup.enableTailnet());
  app.post("/api/setup/push", async () => setup.generatePush());
  app.post("/api/setup/model/probe", async (req) => setup.probeModel(req.body));
}
