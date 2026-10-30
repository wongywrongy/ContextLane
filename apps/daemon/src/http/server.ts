import { basename } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { AddProjectRequest, AnswerRequest, LaneId, ProjectId } from "@contextlanes/protocol";
import { z } from "zod";
import type { EventBus } from "../bus.js";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import type { HostLinks } from "../hosts.js";
import { NotFound, type LaneManager } from "../lanes/manager.js";
import { slugify } from "../lanes/naming.js";
import { runCommand, type Runner } from "../run.js";
import { attachArgs } from "../terminal/tmux.js";
import { connectTerminal } from "../terminal/socket.js";

export type ServerDeps = { store: Store; bus: EventBus; lanes: LaneManager; hosts: HostLinks; config: Config; version: string; run?: Runner };

/** The HTTP API every screen and the CLI use. Bound to loopback; Tailscale Serve sits in front. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { store, bus, config } = deps;
  const run = deps.run ?? runCommand;
  app.register(websocket, {
    options: { maxPayload: 65_536 },
    preClose(done) {
      // Do not wait for browser close handshakes while the daemon is stopping.
      for (const socket of this.websocketServer.clients) socket.terminate();
      this.websocketServer.close(done);
    },
  });

  // Identity comes from Tailscale Serve headers; there are no accounts.
  app.addHook("onRequest", async (req, reply) => {
    const login = req.headers["tailscale-user-login"];
    const owner = config.access.owner;
    if (typeof login === "string") {
      if (owner && login !== owner) return reply.code(403).send({ error: "not the owner of this machine" });
      return;
    }
    if (!config.access.allowLocal) return reply.code(401).send({ error: "open ContextLanes through Tailscale" });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "invalid request", issues: err.issues });
    if (err instanceof NotFound) return reply.code(404).send({ error: err.message });
    return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
  });

  app.get("/api/health", async () => ({ ok: true, version: deps.version, host: config.host.name }));

  // ── projects ──
  app.get("/api/projects", async () => store.listProjects());
  app.post("/api/projects", async (req, reply) => {
    const body = AddProjectRequest.parse(req.body);
    const id = ProjectId.parse(slugify(body.name ?? basename(body.path)));
    reply.code(201);
    return store.addProject({ id, name: body.name ?? basename(body.path), path: body.path });
  });
  app.get<{ Params: { project: string } }>("/api/projects/:project/lanes", async (req) => store.listLanes(ProjectId.parse(req.params.project)));

  // ── lanes ──
  app.post("/api/lanes", async (req, reply) => {
    reply.code(201);
    return deps.lanes.start(req.body);
  });
  app.get<{ Params: { project: string; n: string }; Querystring: { after?: string } }>("/api/lanes/:project/:n/events", async (req) => {
    const lane = laneParam(req.params);
    return store.events(lane, Number(req.query.after ?? 0));
  });
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/prompt", async (req, reply) => {
    const lane = laneParam(req.params);
    const { text } = z.object({ text: z.string().min(1) }).parse(req.body);
    store.appendEvent(lane, { type: "agent.message", payload: { text, role: "user" } });
    if (!deps.hosts.send(lane, { prompt: text })) return reply.code(202).send({ queued: true, delivered: false });
    return reply.code(202).send({ queued: true, delivered: true });
  });

  // Register after the websocket plugin has installed its upgrade hook.
  app.register(async (terminal) => {
    terminal.get<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/terminal", {
      websocket: true,
      preValidation: async (req, reply) => {
        // A web page on another origin must never gain access to the owner's shell.
        if (req.headers.origin) {
          let origin: URL | undefined;
          try { origin = new URL(req.headers.origin); } catch { /* Invalid origins are refused below. */ }
          const localOrigin = origin && ["127.0.0.1", "localhost"].includes(origin.hostname);
          const owner = config.access.owner && req.headers["tailscale-user-login"] === config.access.owner;
          if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host || (!localOrigin && !owner)) {
            return reply.code(403).send({ error: "open the terminal from ContextLanes" });
          }
        }
        if (!store.getLane(laneParam(req.params))) throw new NotFound("no such lane");
      },
    }, (socket, req) => {
      const lane = store.getLane(laneParam(req.params))!;
      try {
        if (!run.terminal) throw new Error("terminal runner unavailable");
        connectTerminal(socket, run.terminal("tmux", attachArgs(lane.terminal), { cwd: lane.worktree, cols: 80, rows: 24 }));
      } catch {
        socket.close(1011, "Could not attach to the lane terminal. Check that tmux is installed and the session exists.");
      }
    });
  });

  // Toolbox calls from agents (packages/toolbox). Each tool is wired up in the phase that owns it.
  app.post<{ Params: { project: string; n: string; tool: string } }>("/api/lanes/:project/:n/tools/:tool", async (req, reply) => {
    laneParam(req.params);
    return reply.code(501).send({ error: `${req.params.tool} is not available yet; see docs/IMPLEMENTATION.md` });
  });

  // ── inbox ──
  app.get("/api/inbox", async () => store.inbox());
  app.post("/api/answers", async (req, reply) => {
    const body = z.object({ lane: LaneId, requestId: z.string() }).and(AnswerRequest).parse(req.body);
    const event = store.appendEvent(body.lane, { type: "permission.answered", payload: { requestId: body.requestId, optionId: body.optionId, by: body.via } });
    bus.publish(event);
    const delivered = deps.hosts.send(body.lane, { answer: { requestId: body.requestId, optionId: body.optionId } });
    return reply.code(202).send({ delivered });
  });

  // ── live stream: one SSE connection per project screen ──
  app.get<{ Params: { project: string } }>("/api/projects/:project/stream", (req, reply) => {
    const project = ProjectId.parse(req.params.project);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    const off = bus.subscribe(project, (e) => res.write(`event: lane\ndata: ${JSON.stringify(e)}\n\n`));
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.raw.on("close", () => {
      clearInterval(beat);
      off();
    });
  });

  return app;
}

function laneParam(p: { project: string; n: string }): string {
  return LaneId.parse(`${p.project}/${p.n}`);
}
