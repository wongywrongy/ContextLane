CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE environments (id TEXT PRIMARY KEY, revision TEXT NOT NULL, observation TEXT NOT NULL, desired TEXT NOT NULL CHECK(desired IN ('running','stopped')));
CREATE TABLE operations (id TEXT PRIMARY KEY, environmentId TEXT NOT NULL REFERENCES environments(id), action TEXT NOT NULL CHECK(action IN ('start','stop')), status TEXT NOT NULL CHECK(status IN ('accepted','running','succeeded','partial','failed')), error TEXT, createdAt TEXT NOT NULL, finishedAt TEXT);
CREATE UNIQUE INDEX one_active_operation ON operations(environmentId) WHERE status IN ('accepted','running');
CREATE TABLE requests (id TEXT PRIMARY KEY, payload TEXT NOT NULL, operation TEXT NOT NULL REFERENCES operations(id));
CREATE TABLE resources (id TEXT PRIMARY KEY, environment TEXT NOT NULL REFERENCES environments(id), operation TEXT NOT NULL REFERENCES operations(id), kind TEXT NOT NULL CHECK(kind IN ('unit','route')), data TEXT NOT NULL, attempted INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, ordinal INTEGER NOT NULL);
CREATE TABLE reservations (key TEXT PRIMARY KEY, resource TEXT NOT NULL REFERENCES resources(id));
CREATE TABLE failure_logs (resource TEXT PRIMARY KEY REFERENCES resources(id), lines TEXT NOT NULL);
