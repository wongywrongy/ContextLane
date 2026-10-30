import { setupRoutes, requestOrigin } from "./setup.js";
import { serveWeb } from "./static.js";
import { ProjectError } from "../projects.js";
import { SetupError, type SetupManager } from "../setup.js";
import type { ServerResponse } from "node:http";
import { basename } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { AddProjectRequest, AnswerRequest, LaneId, ProjectId, UsageQuery } from "@contextlanes/protocol";
import { PromptRequest, ModeRequest, ModelRequest, FileQuery, TakeOverRequest, PlanCollisionRequest, BriefQuery, BriefEdit, ProjectNotes, DelegateRequest, HelperToggle, AskRequest, BenchRequest, HandoffRequest, SecondReviewRequest } from "@contextlanes/protocol";
import { OutsideAgents } from "../outside.js";
import { CodeMaps } from "../codemap.js";
import { Collisions } from "../collisions.js";
import { LocalModels } from "../localmodels.js";
import { Briefs } from "../briefs.js";
import { Helper } from "../helper.js";
import { Insights } from "../insights.js";
import { Ask } from "../ask.js";
import { Bench } from "../bench.js";
import { Handoffs } from "../handoff.js";
import { SecondReviews } from "../second-review.js";
import type { Schedules } from "../schedules.js";
import { Skills } from "../skills.js";

/** Toolbox tools every lane gets; delegate joins them while the local helper has a kind on. */
const LANE_TOOLS = ["ask_owner", "env_status", "env_start", "get_logs", "preview_url", "checkpoint", "get_brief"];
import { TicketRequest, PushSubscription, AskOwnerRequest, LaneEventsQuery, ActivityQuery, ApproveRecipeRequest, CheckpointRequest, LogsQuery, RequestChanges, StartEnvRequest } from "@contextlanes/protocol";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { EventBus } from "../bus.js";
import type { Config } from "../config.js";
import type { Store } from "../db/store.js";
import type { HostLinks } from "../hosts.js";
import { NotFound, Refused, type LaneManager } from "../lanes/manager.js";
import { slugify } from "../lanes/naming.js";
import { attach, laneFiles } from "../attachments.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Checker } from "../checker.js";
import { Review } from "../review.js";
import { laneRecipe, readRecipe } from "../recipes.js";
import { Runtime } from "../runtime.js";
import { Auth } from "./auth.js";
import { runCommand, type Runner } from "../run.js";
import { attachArgs } from "../terminal/tmux.js";
import { connectTerminal } from "../terminal/socket.js";
import { machineInfo, checkForUpdates, exportData } from "../machine.js";
import { Resources } from "../resources.js";

export type ServerDeps = { store: Store; bus: EventBus; lanes: LaneManager; hosts: HostLinks; config: Config; version: string; run?: Runner; setup?: SetupManager; runtime?: Runtime; checker?: Checker; resources?: Resources; outside?: OutsideAgents; codemaps?: CodeMaps; collisions?: Collisions; localModels?: LocalModels; briefs?: Briefs; helper?: Helper; insights?: Insights; schedules?: Schedules; onRoute?: (route: { method: string | string[]; url: string }) => void };

const PUBLIC_ROUTES = new Set(["/api/health", "/api/setup/status", "/api/setup/local", "/api/setup/sign-in", "/api/setup/login/options", "/api/setup/login"]);
const TOOL_ROUTE = "/api/lanes/:project/:n/tools/:tool";
/** The lane token may also ask which tools its lane has. */
const TOOLS_ROUTE = "/api/lanes/:project/:n/tools";

/** The HTTP API every screen and the CLI use. Bound to loopback; Tailscale Serve sits in front. */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  const { store, bus, config } = deps;
  const run = deps.run ?? runCommand;
  const runtime = deps.runtime ?? new Runtime({ store, bus, config, run });
  const checker = deps.checker ?? new Checker({ store, bus, config, run, runtime });
  const review = new Review({ store, bus, hosts: deps.hosts, run, runtime });
  const auth = new Auth(store, config);
  const resources = deps.resources ?? new Resources(store, run);
  const streams = new Set<ServerResponse>();
  if (deps.onRoute) app.addHook("onRoute", deps.onRoute);
  app.addHook("preClose", async () => { for (const stream of streams) stream.end(); });
  app.register(websocket, {
    options: { maxPayload: 65_536 },
    preClose(done) {
      // Do not wait for browser close handshakes while the daemon is stopping.
      for (const socket of this.websocketServer.clients) socket.terminate();
      this.websocketServer.close(done);
    },
  });

  // Every request arrives from loopback through Serve, and a local process can send any header, so only a credential says who is asking.
  app.addHook("onRequest", async (req, reply) => {
    const login = req.headers["tailscale-user-login"];
    const owner = config.access.owner;
    if (typeof login === "string" && owner && login !== owner) return reply.code(403).send({ error: "not the owner of this machine" });
    // The matched route, not req.url: the router decodes %61pi/inbox to /api/inbox.
    const route = req.routeOptions.url;
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");
    if (req.method === "POST" && route === "/api/answers" && bearer?.startsWith("cl-action-")) {
      if (!store.notificationAction(bearer)) return reply.code(401).send({ error: "invalid notification action" });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) requestOrigin(req);
    if (!route?.startsWith("/api/") || PUBLIC_ROUTES.has(route)) return;
    if ((!deps.setup || deps.setup.claimed) && bearer && await auth.owner(bearer)) return;
    if ((route === TOOL_ROUTE || route === TOOLS_ROUTE) && bearer) {
      const { project, n } = req.params as { project: string; n: string };
      if (store.laneForToken(bearer) === `${project}/${n}`) return;
    }
    const ticket = (req.query as { ticket?: unknown }).ticket;
    if (req.method === "GET" && typeof ticket === "string" && auth.spendTicket(ticket, req.url.split("?")[0]!)) return;
    return reply.code(401).send({ error: "Run contextlanes setup in this machine’s SSH session, then open its sign-in link." });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: "Check the values you entered and try again.", code: "invalid_request" });
    if (err instanceof SetupError || err instanceof ProjectError || err instanceof Refused) return reply.code(err.statusCode).send({ error: err.message });
    if (err instanceof NotFound) return reply.code(404).send({ error: "That project or lane could not be found; return to Projects and choose it again." });
    return reply.code(500).send({ error: "This action could not finish; check the daemon logs and try again." });
  });

  if (deps.setup) setupRoutes(app, deps.setup, store, run, auth);
  serveWeb(app);

  app.post("/api/tickets", async (req) => ({ ticket: auth.ticket(TicketRequest.parse(req.body).path) }));
  app.get("/api/health", async () => ({ ok: true, version: deps.version, host: config.host.name }));
  app.get("/api/machine", async () => machineInfo(config, deps.version, run));
  app.post("/api/machine/updates", async () => checkForUpdates(run));
  app.get("/api/data/export", async (_req, reply) => {
    if (!deps.setup) throw new Refused("Setup is unavailable in this daemon.");
    return reply.header("cache-control", "no-store").header("content-disposition", 'attachment; filename="contextlanes-export.json"').send(exportData(store, deps.setup, config, deps.version));
  });
  app.get("/api/usage", async (req) => {
    const { project, since } = UsageQuery.parse(req.query);
    return store.usage(project, since);
  });
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
  app.get("/api/resources", async () => resources.overview());
  app.post("/api/projects", async (req, reply) => {
    if (deps.setup) return reply.code(201).send(await deps.setup.addProject(req.body));
    const body = AddProjectRequest.parse(req.body);
    const id = ProjectId.parse(slugify(body.name ?? basename(body.path)));
    reply.code(201);
    return store.addProject({ id, name: body.name ?? basename(body.path), path: body.path });
  });
  app.get("/api/lanes", async () => store.listLanes());
  app.get<{ Params: { project: string } }>("/api/projects/:project/lanes", async (req) => store.listLanes(ProjectId.parse(req.params.project)));
  app.get<{ Params: { project: string } }>("/api/projects/:project/activity", async (req) => {
    const { since } = ActivityQuery.parse(req.query);
    return store.activity(ProjectId.parse(req.params.project), since ?? new Date(Date.now() - 2 * 60 * 60_000).toISOString());
  });

  // ── recipes ──
  app.get<{ Params: { project: string } }>("/api/projects/:project/recipe", async (req) => {
    const project = store.getProject(ProjectId.parse(req.params.project));
    if (!project) throw new NotFound("no such project");
    return await readRecipe(store, project, project.path);
  });
  app.post<{ Params: { project: string } }>("/api/projects/:project/recipe/approve", async (req, reply) => {
    const project = store.getProject(ProjectId.parse(req.params.project));
    if (!project) throw new NotFound("no such project");
    const { hash } = ApproveRecipeRequest.parse(req.body);
    // Only bytes that exist right now can be approved, and only if they parse.
    const views = await Promise.all([project.path, ...store.listLanes(project.id).filter((l) => !["cleaned", "archived"].includes(l.state)).map((l) => l.worktree)].map((dir) => readRecipe(store, project, dir)));
    const view = views.find((v) => v?.hash === hash);
    if (!view?.recipe) return reply.code(409).send({ error: view?.error ?? "That recipe has changed; review the current file and approve again." });
    const events = store.tx(() => {
      store.approveRecipe(project.id, hash);
      return store.recipeRequests(project.id, hash).map((lane) => store.appendEvent(lane, { type: "recipe.approved", payload: { hash } }));
    });
    for (const event of events) bus.publish(event);
    return { approved: true, hash };
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
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/prompt", { bodyLimit: 24 * 1024 * 1024 }, async (req, reply) => {
    const lane = laneParam(req.params);
    if (!store.getLane(lane)) throw new NotFound(`no lane ${lane}`);
    const body = PromptRequest.parse(req.body);
    const prompt = await attach(config, store.getLane(lane)!, body);
    bus.publish(store.appendEvent(lane, { type: "agent.message", payload: { text: body.text, role: "user", ...(prompt.files.length ? { files: prompt.files } : {}), ...(prompt.images.length ? { images: prompt.images.length } : {}) } }));
    return reply.code(202).send({ queued: true, ...deps.hosts.command(lane, { kind: "prompt", ...prompt }) });
  });
  const outside = deps.outside ?? new OutsideAgents({ run, store, lanes: deps.lanes, data: config.paths.data, lanesDir: config.paths.lanes });
  app.get<{ Params: { project: string } }>("/api/projects/:project/outside-agents", async (req) => ({ agents: await outside.list(ProjectId.parse(req.params.project)) }));
  app.post<{ Params: { project: string } }>("/api/projects/:project/takeover", async (req) => {
    const body = TakeOverRequest.parse(req.body);
    return outside.takeOver(ProjectId.parse(req.params.project), body.pid, body.startedAt);
  });
  const codemaps = deps.codemaps ?? new CodeMaps({ run, store, config });
  app.get<{ Params: { project: string } }>("/api/projects/:project/map", async (req) => codemaps.project(ProjectId.parse(req.params.project)));
  const collisions = deps.collisions ?? new Collisions({ store, bus, codemaps, hosts: deps.hosts });
  app.get<{ Params: { project: string } }>("/api/projects/:project/collisions", async (req) => collisions.active(ProjectId.parse(req.params.project)));
  app.post<{ Params: { project: string } }>("/api/projects/:project/collisions/plan", async (req) => {
    const body = PlanCollisionRequest.parse(req.body);
    return collisions.plan(ProjectId.parse(req.params.project), body.module, body.lane);
  });
  const localModels = deps.localModels ?? new LocalModels({ config, run });
  app.get("/api/models/local", async () => localModels.status());
  const briefs = deps.briefs ?? new Briefs({ config, store, codemaps, models: localModels });
  app.get<{ Params: { project: string } }>("/api/projects/:project/briefs", async (req) => briefs.get(ProjectId.parse(req.params.project), BriefQuery.parse(req.query)));
  app.post<{ Params: { project: string } }>("/api/projects/:project/briefs/write", async (req) => briefs.write(ProjectId.parse(req.params.project), BriefQuery.parse(req.body)));
  app.put<{ Params: { project: string } }>("/api/projects/:project/briefs", async (req) => {
    const body = BriefEdit.extend({ module: z.string().min(1).max(300) }).parse(req.body);
    return briefs.edit(ProjectId.parse(req.params.project), body.module, body.text);
  });
  app.get<{ Params: { project: string } }>("/api/projects/:project/notes", async (req) => ({ text: await briefs.notes(ProjectId.parse(req.params.project)) }));
  app.put<{ Params: { project: string } }>("/api/projects/:project/notes", async (req) => { await briefs.saveNotes(ProjectId.parse(req.params.project), ProjectNotes.parse(req.body).text); return { saved: true }; });
  const helper = deps.helper ?? new Helper({ config, store, bus, models: localModels, run, runtime });
  app.get("/api/helper", async () => helper.status());
  app.post("/api/helper", async (req) => { const b = HelperToggle.parse(req.body); await helper.setKind(b.kind, b.on); return helper.status(); });
  const isBaseline = (lane: string) => { const created = store.events(lane, 0).find((e) => e.type === "lane.created"); return created?.type === "lane.created" && !!created.payload.baseline; };
  app.get<{ Params: { project: string; n: string } }>(TOOLS_ROUTE, async (req) => {
    const lane = store.getLane(laneParam(req.params));
    if (!lane) throw new NotFound("no such lane");
    // A bench baseline lane gets phase 2's tools only, so the comparison measures phase 3.
    if (isBaseline(lane.id)) return { tools: LANE_TOOLS.filter((t) => t !== "get_brief") };
    return { tools: await helper.available() ? [...LANE_TOOLS, "delegate"] : LANE_TOOLS };
  });
  const insights = deps.insights ?? new Insights({ config, store, bus, models: localModels, codemaps, briefs });
  app.get<{ Params: { project: string } }>("/api/projects/:project/insights", async (req) => insights.view(ProjectId.parse(req.params.project)));
  app.post<{ Params: { project: string } }>("/api/projects/:project/insights", async (req) => insights.generate(ProjectId.parse(req.params.project)));
  app.post<{ Params: { project: string; id: string } }>("/api/projects/:project/insights/:id/dismiss", async (req) => { await insights.dismiss(ProjectId.parse(req.params.project), z.uuid().parse(req.params.id)); return { dismissed: true }; });
  const ask = new Ask({ store, codemaps, briefs, models: localModels });
  app.post<{ Params: { project: string } }>("/api/projects/:project/ask", async (req) => ask.ask(ProjectId.parse(req.params.project), AskRequest.parse(req.body).question));
  const bench = new Bench({ config, store, bus, lanes: deps.lanes, run });
  app.post("/api/bench", async (req) => bench.start(BenchRequest.parse(req.body).tasks));
  app.get<{ Params: { id: string } }>("/api/bench/:id", async (req) => (await bench.get(z.uuid().parse(req.params.id))) ?? Promise.reject(new NotFound("no such bench run")));
  const handoffs = new Handoffs({ config, store, bus, hosts: deps.hosts, lanes: deps.lanes, run });
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/handoff", async (req, reply) => reply.code(202).send(await handoffs.replace(laneParam(req.params), HandoffRequest.parse(req.body ?? {}))));
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/fork", async (req) => handoffs.fork(laneParam(req.params), HandoffRequest.parse(req.body ?? {})));
  const secondReviews = new SecondReviews({ store, bus, lanes: deps.lanes, run });
  app.get<{ Params: { id: string } }>("/api/checkpoints/:id/second-review", async (req) => secondReviews.estimate(z.uuid().parse(req.params.id)));
  app.post<{ Params: { id: string } }>("/api/checkpoints/:id/second-review", async (req) => secondReviews.start(z.uuid().parse(req.params.id), SecondReviewRequest.parse(req.body).agent));
  if (deps.schedules) {
    const schedules = deps.schedules;
    app.get("/api/schedules", async () => schedules.list());
    app.post("/api/schedules", async (req) => schedules.add(req.body));
    app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req) => schedules.remove(z.string().regex(/^[a-z0-9-]+$/).parse(req.params.id)));
    app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (req) => schedules.runNow(z.string().regex(/^[a-z0-9-]+$/).parse(req.params.id)));
  }
  const skills = new Skills({ config, store, run });
  app.get<{ Params: { project: string } }>("/api/projects/:project/skills", async (req) => skills.list(ProjectId.parse(req.params.project)));
  app.put<{ Params: { project: string } }>("/api/projects/:project/skills", async (req) => skills.save(ProjectId.parse(req.params.project), req.body));
  app.delete<{ Params: { project: string; name: string } }>("/api/projects/:project/skills/:name", async (req) => skills.remove(ProjectId.parse(req.params.project), req.params.name));
  app.get("/api/editor", async () => ({ url: config.editor.url.replaceAll("{host}", encodeURIComponent(config.host.name)) }));
  app.get<{ Params: { project: string; n: string }; Querystring: { q?: string } }>("/api/lanes/:project/:n/files", async (req) => {
    const lane = store.getLane(laneParam(req.params));
    if (!lane) throw new NotFound("no such lane");
    return { files: await laneFiles(run, lane, FileQuery.parse(req.query).q) };
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

  // ── environments ──
  app.get<{ Params: { project: string } }>("/api/projects/:project/environments", async (req) => {
    const project = store.getProject(ProjectId.parse(req.params.project));
    if (!project) throw new NotFound("no such project");
    // A merged lane still shows while its services run, so they can be stopped before cleanup.
    const lanes = store.listLanes(project.id).filter((l) => !["cleaned", "archived"].includes(l.state) && (l.state !== "merged" || store.environment(l.id)?.services.some((s) => s.state !== "stopped")));
    const [cleanup, recipe, entries, facts] = await Promise.all([review.cleanable(project.id), readRecipe(store, project, project.path),
      Promise.all(lanes.map(async (l) => ({ lane: l.id, recipe: await laneRecipe(store, project, l), environment: store.environment(l.id) }))), resources.project(project.id)]);
    return { cleanup, previews: config.previews.mode, domain: config.previews.caddy?.domain ?? null, recipe, lanes: entries, facts };
  });
  app.get<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/env", async (req) => runtime.status(laneParam(req.params)));
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/env/start", async (req) => runtime.start(laneParam(req.params), StartEnvRequest.parse(req.body ?? {}).services));
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/env/stop", async (req) => runtime.stop(laneParam(req.params)));
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/env/restart", async (req) => {
    await runtime.stop(laneParam(req.params));
    return runtime.start(laneParam(req.params));
  });
  app.get<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/logs", async (req) => {
    const { service, lines } = LogsQuery.parse(req.query);
    return runtime.logs(laneParam(req.params), service, lines);
  });

  // ── checkpoints ──
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/checkpoint", async (req, reply) => reply.code(202).send(await checker.begin(laneParam(req.params), CheckpointRequest.parse(req.body).summary)));
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/approve", async (req) => review.approve(laneParam(req.params)));
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/request-changes", async (req, reply) => {
    return reply.code(202).send(review.requestChanges(laneParam(req.params), RequestChanges.parse(req.body).note));
  });
  app.post<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/cleanup", async (req) => review.cleanup(laneParam(req.params)));
  app.get<{ Params: { project: string } }>("/api/projects/:project/checkpoints", async (req) => store.checkpoints(ProjectId.parse(req.params.project)));
  app.get<{ Params: { id: string; file: string } }>("/api/checkpoints/:id/shots/:file", async (req, reply) => {
    if (!store.checkpoint(req.params.id) || !/^\d+-(before|after)\.png$/.test(req.params.file)) throw new NotFound("no such screenshot");
    const image = await readFile(join(config.paths.data, "checkpoints", req.params.id, req.params.file)).catch(() => { throw new NotFound("no such screenshot"); });
    return reply.type("image/png").header("cache-control", "private, max-age=86400").send(image);
  });
  app.get<{ Params: { id: string }; Querystring: { file?: string } }>("/api/checkpoints/:id/diff", async (req) => {
    const checkpoint = store.checkpoint(req.params.id);
    if (!checkpoint) throw new NotFound("no such checkpoint");
    return { diff: await checker.diff(checkpoint, req.query.file) };
  });

  // Register after the websocket plugin has installed its upgrade hook.
  app.register(async (terminal) => {
    terminal.get<{ Params: { project: string; n: string } }>("/api/lanes/:project/:n/terminal", {
      websocket: true,
      preValidation: async (req, reply) => {
        // A web page on another origin must never gain access to the owner's shell.
        if (req.headers.origin) requestOrigin(req);
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
  app.post<{ Params: { project: string; n: string; tool: string } }>(TOOL_ROUTE, async (req, reply) => {
    const lane = laneParam(req.params);
    if (["get_brief", "delegate"].includes(req.params.tool) && isBaseline(lane)) throw new Refused("This is a bench baseline lane, which runs without phase 3 tools.");
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
    if (req.params.tool === "checkpoint") return reply.code(202).send(await checker.begin(lane, CheckpointRequest.parse(req.body).summary));
    if (req.params.tool === "env_status") return runtime.status(lane);
    if (req.params.tool === "delegate") return helper.delegate(store.getLane(lane)!, DelegateRequest.parse(req.body));
    if (req.params.tool === "get_brief") return { brief: await briefs.forAgent(store.getLane(lane)!.project, BriefQuery.parse(req.body ?? {})) };
    if (req.params.tool === "env_start") return runtime.start(lane, StartEnvRequest.parse(req.body ?? {}).services);
    if (req.params.tool === "preview_url") return runtime.previewUrl(lane, z.object({ service: z.string().default("web") }).parse(req.body ?? {}).service);
    if (req.params.tool === "get_logs") {
      const { service, lines } = LogsQuery.parse(req.body);
      return runtime.logs(lane, service, lines);
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
