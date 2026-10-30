import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  canTransition,
  type Checkpoint,
  type EnvironmentView,
  type InboxItem,
  type Lane,
  type LaneEvent,
  type LaneId,
  type LaneState,
  type NewLaneEvent,
  type EventPayload,
  type Project,
  type ProjectId,
  type UsageSummary,
  type PushSubscription,
  type NotificationChannel,
  parsePayload,
} from "@contextlanes/protocol";
import { MIGRATIONS } from "./migrations.js";

type Row = Record<string, unknown>;

/**
 * SQLite through Node's built-in node:sqlite, with no native database dependency.
 * WAL mode; every write goes through tx() so events and state never disagree.
 */
export class Store {
  private depth = 0;

  private constructor(readonly db: DatabaseSync) {}

  /** Open (or create) the database and bring it to the latest schema. Use ":memory:" in tests. */
  static open(file: string): Store {
    const db = new DatabaseSync(file);
    if (file !== ":memory:") chmodSync(file, 0o600);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const store = new Store(db);
    for (let i = store.schemaVersion(); i < MIGRATIONS.length; i++) {
      store.tx(() => {
        db.exec(MIGRATIONS[i]!);
        db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
    return store;
  }

  schemaVersion(): number {
    return (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  snapshot(): Record<string, Row[]> {
    return this.tx(() => Object.fromEntries((this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map(({ name }) => {
        if (!/^[a-z_]+$/.test(name)) throw new Error("Unexpected database table name");
        return [name, this.db.prepare(`SELECT * FROM ${name}`).all() as Row[]];
      })));
  }

  /** Run fn in a transaction; nested calls become savepoints. */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    this.db.exec(this.depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      this.db.exec(this.depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.depth--;
      this.db.exec(this.depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  // ── projects ────────────────────────────────────────────────────────────

  addProject(p: { id: ProjectId; name: string; path: string; remote?: string | null }): Project {
    this.db
      .prepare("INSERT INTO project (id, name, path, remote, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(p.id, p.name, p.path, p.remote ?? null, now());
    return this.getProject(p.id)!;
  }

  getProject(id: ProjectId): Project | null {
    const r = this.db.prepare("SELECT * FROM project WHERE id = ?").get(id) as Row | undefined;
    return r ? toProject(r) : null;
  }

  listProjects(): Project[] {
    return (this.db.prepare("SELECT * FROM project ORDER BY name").all() as Row[]).map(toProject);
  }

  /** Approvals are per project and exact bytes; recipe_hash remembers the latest one. */
  approveRecipe(project: ProjectId, hash: string): void {
    this.tx(() => {
      this.db.prepare("INSERT OR IGNORE INTO approval (project, recipe_hash, approved_at) VALUES (?, ?, ?)").run(project, hash, now());
      this.db.prepare("UPDATE project SET recipe_hash = ? WHERE id = ?").run(hash, project);
    });
  }

  recipeApproved(project: ProjectId, hash: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM approval WHERE project = ? AND recipe_hash = ?").get(project, hash);
  }

  /** Lanes waiting for this exact recipe, so its approval lands in each of their logs. */
  recipeRequests(project: ProjectId, hash: string): LaneId[] {
    return (this.db.prepare(`SELECT DISTINCT e.lane FROM event e JOIN lane l ON l.id = e.lane WHERE l.project = ? AND e.type = 'recipe.requested' AND json_extract(e.payload, '$.hash') = ?`).all(project, hash) as Row[]).map((r) => String(r.lane));
  }

  // ── lanes ───────────────────────────────────────────────────────────────

  nextLaneNumber(project: ProjectId): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM lane WHERE project = ?").get(project) as { n: number };
    return r.n;
  }

  insertLane(l: Omit<Lane, "createdAt"> & { n: number }): Lane {
    this.db
      .prepare(
        `INSERT INTO lane (id, project, n, goal, task, agent, model, mode, branch, worktree, terminal, host_unit, base, state, colour, created_at)
         VALUES (@id, @project, @n, @goal, @task, @agent, @model, @mode, @branch, @worktree, @terminal, @hostUnit, @base, @state, @colour, @createdAt)`,
      )
      .run({ ...l, goal: l.goal ?? null, model: l.model ?? null, createdAt: now() });
    return this.getLane(l.id)!;
  }

  getLane(id: LaneId): Lane | null {
    const r = this.db.prepare("SELECT * FROM lane WHERE id = ?").get(id) as Row | undefined;
    return r ? toLane(r) : null;
  }

  listLanes(project?: ProjectId): Lane[] {
    const rows = project
      ? this.db.prepare("SELECT * FROM lane WHERE project = ? ORDER BY n").all(project)
      : this.db.prepare("SELECT * FROM lane ORDER BY project, n").all();
    return (rows as Row[]).map(toLane);
  }

  /** Move a lane to a new state and record it, or throw if the lifecycle does not allow it. */
  setLaneState(id: LaneId, to: LaneState, reason?: string): LaneEvent {
    return this.tx(() => {
      const lane = this.getLane(id);
      if (!lane) throw new Error(`no lane ${id}`);
      if (!canTransition(lane.state, to)) throw new Error(`lane ${id} cannot go from ${lane.state} to ${to}`);
      this.db.prepare("UPDATE lane SET state = ? WHERE id = ?").run(to, id);
      return this.appendEvent(id, { type: "lane.state", payload: { from: lane.state, to, ...(reason ? { reason } : {}) } });
    });
  }

  // ── environments ────────────────────────────────────────────────────────

  environment(lane: LaneId): EnvironmentView | null {
    const r = this.db.prepare("SELECT * FROM environment WHERE lane = ?").get(lane) as Row | undefined;
    if (!r) return null;
    const ports = JSON.parse(String(r.ports)) as Record<string, number>;
    const hostnames = JSON.parse(String(r.hostnames)) as Record<string, string | null>;
    const health = JSON.parse(String(r.health)) as Record<string, Pick<EnvironmentView["services"][number], "state" | "detail" | "probes" | "ms" | "lastFailure" | "healthPath" | "healthStatus">>;
    const services = (JSON.parse(String(r.units)) as { name: string; unit: string }[]).map((u) => ({ ...u, port: ports[u.name]!, url: hostnames[u.name] ?? null, ...health[u.name]! }));
    return { lane, recipeHash: String(r.recipe_hash), services, setup: r.setup ? JSON.parse(String(r.setup)) : null, startedAt: (r.started_at as string) ?? null, error: (r.error as string) ?? null };
  }

  saveEnvironment(env: EnvironmentView): void {
    const by = <T,>(pick: (s: EnvironmentView["services"][number]) => T) => JSON.stringify(Object.fromEntries(env.services.map((s) => [s.name, pick(s)])));
    this.db.prepare(`INSERT INTO environment (lane, recipe_hash, units, ports, hostnames, health, updated_at, setup, started_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lane) DO UPDATE SET recipe_hash = excluded.recipe_hash, units = excluded.units, ports = excluded.ports, hostnames = excluded.hostnames, health = excluded.health, updated_at = excluded.updated_at, setup = excluded.setup, started_at = excluded.started_at, error = excluded.error`)
      .run(env.lane, env.recipeHash, JSON.stringify(env.services.map(({ name, unit }) => ({ name, unit }))), by((s) => s.port), by((s) => s.url),
        by(({ state, detail, probes, ms, lastFailure, healthPath, healthStatus }) => ({ state, detail, probes, ms, lastFailure, healthPath, healthStatus })), now(), env.setup ? JSON.stringify(env.setup) : null, env.startedAt, env.error);
  }

  /** Environments with a service that should be up, for the health loop. */
  liveEnvironments(): EnvironmentView[] {
    return (this.db.prepare("SELECT lane FROM environment").all() as Row[]).map((r) => this.environment(String(r.lane))!).filter((e) => e.services.some((s) => s.state !== "stopped"));
  }

  recipeAlreadyRequested(lane: LaneId, hash: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM event WHERE lane = ? AND type = 'recipe.requested' AND json_extract(payload, '$.hash') = ? LIMIT 1").get(lane, hash);
  }

  // ── checkpoints ─────────────────────────────────────────────────────────

  insertCheckpoint(c: Checkpoint): void {
    const { id, lane, base, head, summary, checks, screenshots, createdAt, decision, prUrl, ...packet } = c;
    this.db.prepare("INSERT INTO checkpoint (id, lane, base, head, summary, checks, screenshots, decision, created_at, packet, pr_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, lane, base, head, summary, JSON.stringify(checks), JSON.stringify(screenshots), decision, createdAt, JSON.stringify(packet), prUrl);
  }

  checkpoint(id: string): Checkpoint | null {
    const r = this.db.prepare("SELECT * FROM checkpoint WHERE id = ?").get(id) as Row | undefined;
    return r ? toCheckpoint(r) : null;
  }

  checkpoints(project: ProjectId): Checkpoint[] {
    return (this.db.prepare("SELECT c.* FROM checkpoint c JOIN lane l ON l.id = c.lane WHERE l.project = ? ORDER BY c.created_at DESC").all(project) as Row[]).map(toCheckpoint);
  }

  latestCheckpoint(lane: LaneId): Checkpoint | null {
    const r = this.db.prepare("SELECT * FROM checkpoint WHERE lane = ? ORDER BY created_at DESC LIMIT 1").get(lane) as Row | undefined;
    return r ? toCheckpoint(r) : null;
  }

  decideCheckpoint(id: string, decision: "approved" | "changes", prUrl?: string): void {
    this.db.prepare("UPDATE checkpoint SET decision = ?, pr_url = ? WHERE id = ?").run(decision, prUrl ?? null, id);
  }

  // ── events ──────────────────────────────────────────────────────────────

  /** Append one event; seq is per lane and gap-free. Payloads are validated on the way in. */
  appendEvent(lane: LaneId, ev: NewLaneEvent, sourceId?: string): LaneEvent {
    const payload = parsePayload(ev.type, ev.payload);
    return this.tx(() => {
      if (sourceId) {
        const previous = this.eventBySource(lane, sourceId);
        if (previous) return previous;
      }
      const { seq } = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM event WHERE lane = ?").get(lane) as { seq: number };
      const at = now();
      this.db.prepare("INSERT INTO event (lane, seq, at, type, payload, source_id) VALUES (?, ?, ?, ?, ?, ?)").run(lane, seq, at, ev.type, JSON.stringify(payload), sourceId ?? null);
      return { lane, seq, at, type: ev.type, payload } as LaneEvent;
    });
  }

  eventBySource(lane: LaneId, sourceId: string): LaneEvent | null {
    const r = this.db.prepare("SELECT * FROM event WHERE lane = ? AND source_id = ?").get(lane, sourceId) as Row | undefined;
    return r ? toEvent(r) : null;
  }

  pendingCommands(lane: LaneId): Extract<LaneEvent, { type: "agent.command" }>[] {
    return (this.db.prepare(`SELECT c.* FROM event c WHERE c.lane = ? AND c.type = 'agent.command'
      AND NOT EXISTS (SELECT 1 FROM event a WHERE a.lane = c.lane AND a.type = 'agent.command.result'
      AND json_extract(a.payload, '$.commandId') = json_extract(c.payload, '$.commandId')) ORDER BY c.seq`).all(lane) as Row[])
      .map(toEvent) as Extract<LaneEvent, { type: "agent.command" }>[];
  }

  permission(lane: LaneId, requestId: string): EventPayload<"permission.requested"> | null {
    const row = this.db.prepare("SELECT payload FROM event WHERE lane = ? AND type = 'permission.requested' AND json_extract(payload, '$.requestId') = ? ORDER BY seq DESC LIMIT 1").get(lane, requestId) as Row | undefined;
    return row ? JSON.parse(String(row.payload)) : null;
  }

  answered(lane: LaneId, requestId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM event WHERE lane = ? AND type = 'permission.answered' AND json_extract(payload, '$.requestId') = ? LIMIT 1").get(lane, requestId);
  }

  answer(lane: LaneId, requestId: string): EventPayload<"permission.answered"> | null {
    const row = this.db.prepare("SELECT payload FROM event WHERE lane = ? AND type = 'permission.answered' AND json_extract(payload, '$.requestId') = ? LIMIT 1").get(lane, requestId) as Row | undefined;
    return row ? JSON.parse(String(row.payload)) : null;
  }

  events(lane: LaneId, afterSeq = 0, limit = 500): LaneEvent[] {
    const rows = this.db.prepare("SELECT * FROM event WHERE lane = ? AND seq > ? ORDER BY seq LIMIT ?").all(lane, afterSeq, limit) as Row[];
    return rows.map(toEvent);
  }

  usage(project?: ProjectId, since?: string): UsageSummary {
    const sum = `COUNT(*) AS turns,
      CASE WHEN COUNT(json_extract(e.payload, '$.inputTokens')) = COUNT(*) THEN SUM(json_extract(e.payload, '$.inputTokens')) END AS inputTokens,
      CASE WHEN COUNT(json_extract(e.payload, '$.outputTokens')) = COUNT(*) THEN SUM(json_extract(e.payload, '$.outputTokens')) END AS outputTokens,
      CASE WHEN COUNT(json_extract(e.payload, '$.cacheReadTokens')) = COUNT(*) THEN SUM(json_extract(e.payload, '$.cacheReadTokens')) END AS cacheReadTokens,
      CASE WHEN COUNT(json_extract(e.payload, '$.cacheWriteTokens')) = COUNT(*) THEN SUM(json_extract(e.payload, '$.cacheWriteTokens')) END AS cacheWriteTokens,
      SUM(json_extract(e.payload, '$.costUsd')) AS costUsd, COUNT(json_extract(e.payload, '$.costUsd')) AS costTurns`;
    const from = `FROM event e JOIN lane l ON l.id = e.lane WHERE e.type = 'usage.turn'
      AND (? IS NULL OR l.project = ?) AND (? IS NULL OR e.at >= ?)
      AND NOT EXISTS (SELECT 1 FROM event earlier WHERE earlier.lane = e.lane AND earlier.type = 'usage.turn'
        AND earlier.seq < e.seq AND json_extract(earlier.payload, '$.turnId') = json_extract(e.payload, '$.turnId'))`;
    const args = [project ?? null, project ?? null, since ?? null, since ?? null];
    return {
      lanes: this.db.prepare(`SELECT e.lane, ${sum} ${from} GROUP BY e.lane ORDER BY e.lane`).all(...args),
      days: this.db.prepare(`SELECT substr(e.at, 1, 10) AS day, ${sum} ${from} GROUP BY day ORDER BY day`).all(...args),
      limits: (this.db.prepare(`SELECT agent, payload FROM (SELECT l.agent, e.payload,
        ROW_NUMBER() OVER (PARTITION BY l.agent, json_extract(e.payload, '$.window') ORDER BY e.at DESC, e.rowid DESC) AS position
        FROM event e JOIN lane l ON l.id = e.lane WHERE e.type = 'usage.limit'
        AND (? IS NULL OR l.project = ?) AND (? IS NULL OR e.at >= ?))
        WHERE position = 1 AND json_extract(payload, '$.resetsAt') > ? ORDER BY agent, json_extract(payload, '$.window')`)
        .all(...args, now()) as Row[]).map((r) => ({ agent: String(r.agent), ...JSON.parse(String(r.payload)) })),
    } as UsageSummary;
  }

  activity(project: ProjectId, since: string): LaneEvent[] {
    const rows = this.db.prepare(`SELECT e.* FROM event e JOIN lane l ON l.id = e.lane WHERE l.project = ? AND
      (e.at >= ? OR (e.type IN ('lane.state', 'agent.turn') AND e.seq =
        (SELECT MAX(p.seq) FROM event p WHERE p.lane = e.lane AND p.type = e.type AND p.at < ?))) ORDER BY e.lane, e.seq`).all(project, since, since) as Row[];
    return rows.map(toEvent);
  }

  /** Everything waiting on the owner: unanswered permission requests, lanes in review, and each lane's latest unapproved recipe (an older one was replaced by the edit). */
  inbox(): InboxItem[] {
    const asks = this.db
      .prepare(
        `SELECT q.lane, q.at, json_extract(q.payload, '$.requestId') AS rid, json_extract(q.payload, '$.title') AS title, json_extract(q.payload, '$.options') AS options, json_extract(q.payload, '$.kind') AS kind
         FROM event q
         WHERE q.type = 'permission.requested'
           AND NOT EXISTS (
             SELECT 1 FROM event a WHERE a.lane = q.lane AND a.type = 'permission.answered'
               AND json_extract(a.payload, '$.requestId') = json_extract(q.payload, '$.requestId'))
         ORDER BY q.at`,
      )
      .all() as Row[];
    const reviews = this.db.prepare("SELECT l.id, l.task, (SELECT MAX(c.created_at) FROM checkpoint c WHERE c.lane = l.id) AS at FROM lane l WHERE l.state = 'in_review' ORDER BY l.created_at").all() as Row[];
    const recipes = this.db.prepare(`SELECT r.lane, MIN(r.at) AS at, json_extract(r.payload, '$.hash') AS hash FROM event r JOIN lane l ON l.id = r.lane
      WHERE r.type = 'recipe.requested' AND l.state NOT IN ('merged', 'cleaned', 'archived')
        AND r.seq = (SELECT MAX(r2.seq) FROM event r2 WHERE r2.lane = r.lane AND r2.type = 'recipe.requested')
        AND NOT EXISTS (SELECT 1 FROM approval a WHERE a.project = l.project AND a.recipe_hash = json_extract(r.payload, '$.hash'))
      GROUP BY r.lane, hash ORDER BY at`).all() as Row[];
    return [
      ...recipes.map((r) => ({ id: `${r.lane}#recipe-${r.hash}`, lane: String(r.lane), kind: "approval" as const, title: `Approve the recipe ${String(r.hash).slice(0, 7)} on the Run page`, since: String(r.at), options: [] })),
      ...asks.map((r) => ({ id: `${r.lane}#${r.rid}`, lane: String(r.lane), kind: r.kind === "question" ? "question" as const : "permission" as const, title: String(r.title), since: String(r.at), options: JSON.parse(String(r.options)) })),
      ...reviews.map((r) => ({ id: `${r.id}#review`, lane: String(r.id), kind: "review" as const, title: `Review: ${r.task}`, since: (r.at as string) ?? now(), options: [] })),
    ];
  }

  saveSubscription(subscription: PushSubscription): void {
    this.db.prepare("INSERT INTO push_subscription VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription").run(subscription.endpoint, JSON.stringify(subscription));
  }

  subscriptions(): PushSubscription[] {
    return (this.db.prepare("SELECT subscription FROM push_subscription").all() as Row[]).map((r) => JSON.parse(String(r.subscription)));
  }

  removeSubscription(endpoint: string): void { this.db.prepare("DELETE FROM push_subscription WHERE endpoint = ?").run(endpoint); }

  action(lane: string, requestId: string, optionId: string, channel: NotificationChannel): string {
    const token = `cl-action-${randomBytes(32).toString("base64url")}`;
    this.db.prepare("INSERT INTO notification_action VALUES (?, ?, ?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), lane, requestId, optionId, channel);
    return token;
  }

  notificationAction(token: string): { lane: string; requestId: string; optionId: string; via: "phone" | "telegram" } | null {
    if (!/^cl-action-[\w-]{43}$/.test(token)) return null;
    const row = this.db.prepare("SELECT * FROM notification_action WHERE hash = ?").get(createHash("sha256").update(token).digest("hex")) as Row | undefined;
    return row ? { lane: String(row.lane), requestId: String(row.request_id), optionId: String(row.option_id), via: row.channel === "telegram" ? "telegram" : "phone" } : null;
  }

  notified(lane: string, requestId: string, channel: NotificationChannel, target = ""): boolean {
    return !!this.db.prepare("SELECT 1 FROM event WHERE lane = ? AND type = 'notification.sent' AND json_extract(payload, '$.requestId') = ? AND json_extract(payload, '$.channel') = ? AND COALESCE(json_extract(payload, '$.target'), '') = ? LIMIT 1").get(lane, requestId, channel, target);
  }

  telegramOffset(): number { return Number((this.db.prepare("SELECT offset FROM notification_cursor WHERE id = 1").get() as Row | undefined)?.offset ?? 0); }
  setTelegramOffset(offset: number): void { this.db.prepare("INSERT INTO notification_cursor VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET offset = excluded.offset").run(offset); }

  hasStartedLane(): boolean {
    return !!this.db.prepare("SELECT 1 FROM event WHERE type = 'lane.state' AND json_extract(payload, '$.to') = 'working' LIMIT 1").get();
  }

  setupLink(origin: string): { token: string; expiresAt: string } {
    const token = randomBytes(32).toString("base64url");
    const expires = Date.now() + 600_000;
    this.db.prepare("DELETE FROM setup_link WHERE expires <= ?").run(Date.now());
    this.db.prepare("INSERT INTO setup_link VALUES (?, ?, ?)").run(createHash("sha256").update(token).digest("hex"), expires, origin);
    return { token, expiresAt: new Date(expires).toISOString() };
  }

  consumeSetupLink(token: string, origin: string): boolean {
    return !!this.db.prepare("DELETE FROM setup_link WHERE hash = ? AND expires > ? AND origin = ? RETURNING hash")
      .get(createHash("sha256").update(token).digest("hex"), Date.now(), origin);
  }

  ownerSession(): string {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM owner_session WHERE expires < ?").run(Date.now());
    this.db.prepare("INSERT INTO owner_session VALUES (?, ?)").run(createHash("sha256").update(token).digest("hex"), Date.now() + 30 * 86_400_000);
    return token;
  }

  /** A new token for this lane's host and toolbox. Only its hash is kept. */
  mintLaneToken(lane: string): string {
    const token = `cl-lane-${randomBytes(32).toString("base64url")}`;
    this.db.prepare("UPDATE lane SET token_hash = ? WHERE id = ?").run(createHash("sha256").update(token).digest("hex"), lane);
    return token;
  }

  /** The lane this token belongs to. A cleaned or archived lane's token stops working. */
  laneForToken(token: string): string | null {
    const row = this.db.prepare("SELECT id FROM lane WHERE token_hash = ? AND state NOT IN ('cleaned', 'archived')").get(createHash("sha256").update(token).digest("hex")) as { id: string } | undefined;
    return row?.id ?? null;
  }

  hasLaneToken(lane: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM lane WHERE id = ? AND token_hash IS NOT NULL").get(lane);
  }

  validOwnerSession(token: string): boolean {
    if (!/^[\w-]{43}$/.test(token)) return false;
    return !!this.db.prepare("SELECT 1 FROM owner_session WHERE hash = ? AND expires > ?").get(createHash("sha256").update(token).digest("hex"), Date.now());
  }
}

function toEvent(r: Row): LaneEvent {
  return { lane: String(r.lane), seq: Number(r.seq), at: String(r.at), type: r.type, payload: JSON.parse(String(r.payload)) } as LaneEvent;
}

function now(): string {
  return new Date().toISOString();
}

function toCheckpoint(r: Row): Checkpoint {
  return { id: String(r.id), lane: String(r.lane), base: String(r.base), head: String(r.head), summary: String(r.summary), checks: JSON.parse(String(r.checks)), screenshots: JSON.parse(String(r.screenshots)),
    ...JSON.parse(String(r.packet)), decision: (r.decision as Checkpoint["decision"]) ?? null, prUrl: (r.pr_url as string) ?? null, createdAt: String(r.created_at) };
}

function toProject(r: Row): Project {
  return { id: String(r.id), name: String(r.name), path: String(r.path), remote: (r.remote as string) ?? null, recipeHash: (r.recipe_hash as string) ?? null };
}

function toLane(r: Row): Lane {
  return {
    id: String(r.id),
    project: String(r.project),
    goal: (r.goal as string) ?? null,
    task: String(r.task),
    agent: String(r.agent),
    model: (r.model as string) ?? null,
    mode: r.mode as Lane["mode"],
    branch: String(r.branch),
    worktree: String(r.worktree),
    terminal: String(r.terminal),
    hostUnit: (r.host_unit as string) ?? null,
    base: (r.base as string) ?? null,
    state: r.state as LaneState,
    colour: r.colour as Lane["colour"],
    createdAt: String(r.created_at),
  };
}
