import { DatabaseSync } from "node:sqlite";
import {
  canTransition,
  type InboxItem,
  type Lane,
  type LaneEvent,
  type LaneId,
  type LaneState,
  type NewLaneEvent,
  type Project,
  type ProjectId,
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

  // ── lanes ───────────────────────────────────────────────────────────────

  nextLaneNumber(project: ProjectId): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM lane WHERE project = ?").get(project) as { n: number };
    return r.n;
  }

  insertLane(l: Omit<Lane, "createdAt"> & { n: number }): Lane {
    this.db
      .prepare(
        `INSERT INTO lane (id, project, n, goal, task, agent, model, mode, branch, worktree, terminal, state, colour, created_at)
         VALUES (@id, @project, @n, @goal, @task, @agent, @model, @mode, @branch, @worktree, @terminal, @state, @colour, @createdAt)`,
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

  // ── events ──────────────────────────────────────────────────────────────

  /** Append one event; seq is per lane and gap-free. Payloads are validated on the way in. */
  appendEvent(lane: LaneId, ev: NewLaneEvent): LaneEvent {
    const payload = parsePayload(ev.type, ev.payload);
    return this.tx(() => {
      const { seq } = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM event WHERE lane = ?").get(lane) as { seq: number };
      const at = now();
      this.db.prepare("INSERT INTO event (lane, seq, at, type, payload) VALUES (?, ?, ?, ?, ?)").run(lane, seq, at, ev.type, JSON.stringify(payload));
      return { lane, seq, at, type: ev.type, payload } as LaneEvent;
    });
  }

  events(lane: LaneId, afterSeq = 0, limit = 500): LaneEvent[] {
    const rows = this.db.prepare("SELECT * FROM event WHERE lane = ? AND seq > ? ORDER BY seq LIMIT ?").all(lane, afterSeq, limit) as Row[];
    return rows.map((r) => ({ lane: r.lane, seq: r.seq, at: r.at, type: r.type, payload: JSON.parse(String(r.payload)) }) as LaneEvent);
  }

  /** Everything waiting on the owner: unanswered permission requests and lanes in review. */
  inbox(): InboxItem[] {
    const asks = this.db
      .prepare(
        `SELECT q.lane, q.at, json_extract(q.payload, '$.requestId') AS rid, json_extract(q.payload, '$.title') AS title
         FROM event q
         WHERE q.type = 'permission.requested'
           AND NOT EXISTS (
             SELECT 1 FROM event a WHERE a.lane = q.lane AND a.type = 'permission.answered'
               AND json_extract(a.payload, '$.requestId') = json_extract(q.payload, '$.requestId'))
         ORDER BY q.at`,
      )
      .all() as Row[];
    const reviews = this.db.prepare("SELECT id, task FROM lane WHERE state = 'in_review' ORDER BY created_at").all() as Row[];
    return [
      ...asks.map((r) => ({ id: `${r.lane}#${r.rid}`, lane: String(r.lane), kind: "permission" as const, title: String(r.title), since: String(r.at) })),
      ...reviews.map((r) => ({ id: `${r.id}#review`, lane: String(r.id), kind: "review" as const, title: `Review: ${r.task}`, since: now() })),
    ];
  }
}

function now(): string {
  return new Date().toISOString();
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
    state: r.state as LaneState,
    colour: r.colour as Lane["colour"],
    createdAt: String(r.created_at),
  };
}
