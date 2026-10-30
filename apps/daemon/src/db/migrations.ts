/**
 * Plain SQL migrations, applied in order and tracked with PRAGMA user_version.
 * Six tables hold everything; the inbox, timelines and insights are queries over `event`.
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
];
