import { setupRoutes, requestOrigin } from "./setup.js";
import { serveWeb } from "./static.js";
import { ProjectError } from "../projects.js";
import { SetupError, type SetupManager } from "../setup.js";
import type { ServerResponse } from "node:http";
import { basename } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { AddProjectRequest, AnswerRequest, LaneId, ProjectId } from "@contextlanes/protocol";
import { PromptRequest, ModeRequest, ModelRequest } from "@contextlanes/protocol";
import { PushSubscription, AskOwnerRequest, LaneEventsQuery, ActivityQuery } from "@contextlanes/protocol";
import { randomUUID } from "node:crypto";
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

export type ServerDeps = { store: Store; bus: EventBus; lanes: LaneManager; hosts: HostLinks; config: Config; version: string; run?: Runner; setup?: SetupManager };

/** The HTTP API every screen and the CLI use. Bound to loopback; Tailscale Serve sits in front. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { store, bus, config } = deps;
  const run = deps.run ?? runCommand;
  const streams = new Set<ServerResponse>();
  app.addHook("preClose", async () => { for (const stream of streams) stream.end(); });
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
    if (typeof login === "string" && owner && login !== owner) return reply.code(403).send({ error: "not the owner of this machine" });
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    if (req.method === "POST" && req.url.split("?")[0] === "/api/answers" && bearer?.startsWith("cl-action-")) {
      if (!store.notificationAction(bearer)) return reply.code(401).send({ error: "invalid notification action" });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) requestOrigin(req);
    if (deps.setup) {
      const path = req.url.split("?")[0]!;
      const publicApi = ["/api/health", "/api/setup/status", "/api/setup/local", "/api/setup/sign-in", "/api/setup/login/options", "/api/setup/login"];
      if (!path.startsWith("/api/") || publicApi.includes(path)) return;
      if (!deps.setup.authorized(login, req.headers.cookie, req.hostname)) return reply.code(401).send({ error: "Run contextlanes setup in this machine’s SSH session, then open its sign-in link." });
      return;
    }
    if (typeof login === "string") return;
    if (!config.access.allowLocal) return reply.code(401).send({ error: "open ContextLanes through Tailscale" });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Check the values you entered and try again.", code: "invalid_request" });
    if (err instanceof SetupError || err instanceof ProjectError) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof NotFound) return reply.code(404).send({ error: "That project or lane could not be found; return to Projects and choose it again." });
    return reply.code(500).send({ error: "This action could not finish; check the daemon logs and try again." });
  });

  if (deps.setup) setupRoutes(app, deps.setup, store, run);
  serveWeb(app);

  app.get("/api/health", async () => ({ ok: true, version: deps.version, host: config.host.name }));
  app.get("/api/notifications", async () => ({ publicKey: config.notifications.webPush?.publicKey ?? null,
    channels: { ntfy: !!config.notifications.ntfy, telegram: !!config.notifications.telegram, webpush: !!config.notifications.webPush }, quiet: config.notifications.quiet ?? null }));
  app.post("/api/push/subscriptions", async (req, reply) => {
    store.saveSubscription(PushSubscription.parse(req.body));
    return reply.code(201).send({ subscribed: true });
  });
  app.delete("/api/push/subscriptions", async (req) => {
    const { endpoint } = PushSubscription.pick({ endpoint: true }).parse(req.body);
    store.removeSubscription(endpoint);
    return { subscribed: false };
  });

  // ── projects ──
  app.get("/api/projects", async () => store.listProjects());
  app.post("/api/projects", async (req, reply) => {
    if (deps.setup) return reply.code(201).send(await deps.setup.addProject(req.body));
    const body = AddProjectRequest.parse(req.body);
    const id = ProjectId.parse(slugify(body.name ?? basename(body.path)));
    reply.code(201);
    return store.addProject({ id, name: body.name ?? basename(body.path), path: body.path });
  });
  app.get<{ Params: { project: string } }>("/api/projects/:project/lanes", async (req) => store.listLanes(ProjectId.parse(req.params.project)));
  app.get<{ Params: { project: string } }>("/api/projects/:project/activity", async (req) => {
    const { since } = ActivityQuery.parse(req.query);
    return store.activity(ProjectId.parse(req.params.project), since ?? new Date(Date.now() - 2 * 60 * 60_000).toISOString());
  });

  // ── lanes ──
  app.post("/api/lanes", async (req, reply) => {
    reply.code(201);
    return deps.lanes.start(req.body);
  });
  app.get<{ Params: { project: string; n: string }; Querystring: { after?: string } }>("/api/lanes/:project/:n/events", async (req) => {
    const lane = laneParam(req.params);
    return store.events(lane, LaneEventsQuery.parse(req.query).after);
  });
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/prompt", async (req, reply) => {
    const lane = laneParam(req.params);
    if (!store.getLane(lane)) throw new NotFound(`no lane ${lane}`);
    const body = PromptRequest.parse(req.body);
    bus.publish(store.appendEvent(lane, { type: "agent.message", payload: { text: body.text, role: "user" } }));
    return reply.code(202).send({ queued: true, ...deps.hosts.command(lane, { kind: "prompt", ...body }) });
  });
  for (const action of ["cancel", "mode", "model"] as const) {
    app.post<{ Params: { project: string; n: string } }>(`/api/lanes/:project/:n/${action}`, async (req, reply) => {
      const lane = laneParam(req.params);
      if (!store.getLane(lane)) throw new NotFound(`no lane ${lane}`);
      const command = action === "cancel" ? { kind: "cancel" as const } : action === "mode" ?
        { kind: "mode" as const, ...ModeRequest.parse(req.body) } : { kind: "model" as const, ...ModelRequest.parse(req.body) };
      return reply.code(202).send(deps.hosts.command(lane, command));
    });
  }

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
          const owner = deps.setup ? deps.setup.authorized(req.headers["tailscale-user-login"], req.headers.cookie, req.hostname) : config.access.owner && req.headers["tailscale-user-login"] === config.access.owner;
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
    const lane = laneParam(req.params);
    if (req.params.tool === "ask_owner") {
      if (!store.getLane(lane)) throw new NotFound(`no lane ${lane}`);
      const body = AskOwnerRequest.parse(req.body);
      if (!store.permission(lane, body.requestId)) {
        bus.publish(store.appendEvent(lane, { type: "permission.requested", payload: { requestId: body.requestId, title: body.question, kind: "question", options: body.options.map((label, i) => ({ id: String(i), label, kind: "allow_once" })) } }));
        if (store.getLane(lane)!.state === "working") bus.publish(store.setLaneState(lane, "needs_you"));
      }
      const original = store.permission(lane, body.requestId)!;
      if (original.kind !== "question" || original.title !== body.question || JSON.stringify(original.options.map((o) => o.label)) !== JSON.stringify(body.options)) return reply.code(409).send({ error: "question ID already has different content" });
      const answer = store.answer(lane, body.requestId);
      return answer ? { optionId: answer.optionId, label: original.options.find((o) => o.id === answer.optionId)?.label ?? null } : reply.code(202).send({ pending: true, requestId: body.requestId });
    }
    return reply.code(501).send({ error: `${req.params.tool} is not available yet; see docs/IMPLEMENTATION.md` });
  });

  // ── inbox ──
  app.get("/api/inbox", async () => store.inbox());
  app.post("/api/answers", async (req, reply) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    const action = bearer?.startsWith("cl-action-") ? store.notificationAction(bearer) : null;
    const body = z.object({ lane: LaneId, requestId: z.string() }).and(AnswerRequest).parse(action ?? req.body);
    const request = store.permission(body.lane, body.requestId);
    if (!request) return reply.code(404).send({ error: "no such permission" });
    if (store.answered(body.lane, body.requestId)) return reply.code(409).send({ error: "permission already answered" });
    if (body.optionId !== null && !request.options.some((o) => o.id === body.optionId)) return reply.code(400).send({ error: "not an offered permission option" });
    const commandId = randomUUID();
    const command = { kind: "answer" as const, requestId: body.requestId, optionId: body.optionId };
    const events = store.tx(() => {
      const events = [store.appendEvent(body.lane, { type: "permission.answered", payload: { requestId: body.requestId, optionId: body.optionId, by: body.via } })];
      if (request.kind !== "question") events.push(store.appendEvent(body.lane, { type: "agent.command", payload: { commandId, command } }));
      if (store.getLane(body.lane)?.state === "needs_you" && !store.inbox().some((i) => i.lane === body.lane && ["permission", "question"].includes(i.kind))) events.push(store.setLaneState(body.lane, "working"));
      return events;
    });
    for (const event of events) bus.publish(event);
    return reply.code(202).send({ commandId, delivered: request.kind === "question" || deps.hosts.send(body.lane, { commandId, command }) });
  });

  // ── live stream: one SSE connection per project screen ──
  for (const path of ["/api/projects/:project/stream", "/api/stream"]) app.get<{ Params: { project?: string } }>(path, (req, reply) => {
    const project = req.params.project ? ProjectId.parse(req.params.project) : null;
    reply.hijack();
    const res = reply.raw;
    streams.add(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("retry: 2000\n\n");
    const write = (e: import("@contextlanes/protocol").LaneEvent) => { res.write(`event: lane\ndata: ${JSON.stringify(e)}\n\n`); };
    const off = project ? bus.subscribe(project, write) : bus.subscribeAll(write);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    res.on("close", () => {
      streams.delete(res);
      clearInterval(beat);
      off();
    });
  });

  return app;
}

function laneParam(p: { project: string; n: string }): string {
  return LaneId.parse(`${p.project}/${p.n}`);
}
