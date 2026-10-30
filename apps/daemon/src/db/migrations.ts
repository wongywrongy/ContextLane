/**
 * Plain SQL migrations, applied in order and tracked with PRAGMA user_version.
 * Core tables hold work; notification transport and owner sessions are separate.
 * The inbox, timelines and insights are queries over `event`.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1 */ `
  CREATE TABLE project (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    path         TEXT NOT NULL UNIQUE,
    remote       TEXT,
    recipe_hash  TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE lane (
    id          TEXT PRIMARY KEY,
    project     TEXT NOT NULL REFERENCES project(id),
    n           INTEGER NOT NULL,
    goal        TEXT,
    task        TEXT NOT NULL,
    agent       TEXT NOT NULL,
    model       TEXT,
    mode        TEXT NOT NULL,
    branch      TEXT NOT NULL,
    worktree    TEXT NOT NULL,
    terminal    TEXT NOT NULL,
    host_unit   TEXT,
    state       TEXT NOT NULL,
    colour      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE (project, n)
  );

  CREATE TABLE event (
    lane     TEXT NOT NULL REFERENCES lane(id),
    seq      INTEGER NOT NULL,
    at       TEXT NOT NULL,
    type     TEXT NOT NULL,
    payload  TEXT NOT NULL,
    PRIMARY KEY (lane, seq)
  );
  CREATE INDEX event_type ON event(type, at);

  CREATE TABLE checkpoint (
    id           TEXT PRIMARY KEY,
    lane         TEXT NOT NULL REFERENCES lane(id),
    base         TEXT NOT NULL,
    head         TEXT NOT NULL,
    summary      TEXT NOT NULL,
    checks       TEXT NOT NULL DEFAULT '[]',
    screenshots  TEXT NOT NULL DEFAULT '[]',
    decision     TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE environment (
    lane         TEXT PRIMARY KEY REFERENCES lane(id),
    recipe_hash  TEXT NOT NULL,
    units        TEXT NOT NULL DEFAULT '[]',
    ports        TEXT NOT NULL DEFAULT '{}',
    hostnames    TEXT NOT NULL DEFAULT '{}',
    health       TEXT NOT NULL DEFAULT '{}',
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE approval (
    project      TEXT NOT NULL REFERENCES project(id),
    recipe_hash  TEXT NOT NULL,
    approved_at  TEXT NOT NULL,
    PRIMARY KEY (project, recipe_hash)
  );
  `,
  /* 2 */ `ALTER TABLE event ADD COLUMN source_id TEXT;
  CREATE UNIQUE INDEX event_source ON event(lane, source_id) WHERE source_id IS NOT NULL;`,
  /* 3 */ `CREATE TABLE push_subscription (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL);
  CREATE TABLE notification_action (hash TEXT PRIMARY KEY, lane TEXT NOT NULL REFERENCES lane(id), request_id TEXT NOT NULL, option_id TEXT NOT NULL, channel TEXT NOT NULL);
  CREATE TABLE notification_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), offset INTEGER NOT NULL);`,
  /* 4 */ `CREATE TABLE owner_session (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);`,
  /* 5 */ `CREATE TABLE setup_link (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL, origin TEXT NOT NULL);`,
  /* 6 */ `ALTER TABLE environment ADD COLUMN setup TEXT;
  ALTER TABLE environment ADD COLUMN started_at TEXT;
  ALTER TABLE environment ADD COLUMN error TEXT;`,
  /* 7 */ `ALTER TABLE lane ADD COLUMN base TEXT;
  ALTER TABLE checkpoint ADD COLUMN packet TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE checkpoint ADD COLUMN pr_url TEXT;`,
  /* 8 */ `ALTER TABLE lane ADD COLUMN token_hash TEXT;
  DELETE FROM owner_session;`,
  /* 9 */ `ALTER TABLE project ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE project ADD COLUMN position INTEGER;
  ALTER TABLE project ADD COLUMN removed_at TEXT;`,
  /* 10 */ `CREATE INDEX event_lane_type ON event(lane, type, seq);
  CREATE INDEX event_at ON event(at);`,
];
