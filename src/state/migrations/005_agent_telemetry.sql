CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL CHECK(agent IN ('claude','codex')),
  session_key TEXT NOT NULL,
  pid INTEGER,
  cwd TEXT,
  project_id TEXT,
  match TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  mode TEXT,
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(agent,session_key)
);
CREATE INDEX agent_sessions_retention ON agent_sessions(last_seen_at);
CREATE TABLE agent_session_counters (
  session TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY(session,key)
);
CREATE TABLE agent_session_tools (
  session TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  tool TEXT NOT NULL,
  calls INTEGER NOT NULL,
  failures INTEGER NOT NULL,
  rejects INTEGER NOT NULL,
  total_ms REAL NOT NULL,
  p95_ms REAL,
  PRIMARY KEY(session,tool)
);
CREATE TABLE agent_session_toolkit (
  session TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('mcp','skill','plugin')),
  name TEXT NOT NULL,
  version TEXT,
  status TEXT NOT NULL CHECK(status IN ('connected','failed','active')),
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(session,kind,name)
);
CREATE TABLE agent_session_context (
  session TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
  used_pct REAL,
  window INTEGER,
  input INTEGER,
  cacheRead INTEGER,
  cacheCreation INTEGER,
  rate_5h_pct REAL,
  rate_5h_resets_at TEXT,
  rate_7d_pct REAL,
  rate_7d_resets_at TEXT,
  observed_at TEXT NOT NULL
);
CREATE TABLE rootlane_tool_calls (
  pid INTEGER NOT NULL,
  session TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  tool TEXT NOT NULL,
  calls INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY(pid,tool)
);
CREATE INDEX rootlane_tool_calls_retention ON rootlane_tool_calls(last_at);
