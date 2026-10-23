CREATE TABLE local_recipes (
 checkoutPath TEXT PRIMARY KEY, recipe TEXT NOT NULL, tools TEXT NOT NULL,
 updatedAt TEXT NOT NULL
);
CREATE TABLE preparations (
 id TEXT PRIMARY KEY, checkoutPath TEXT NOT NULL, fingerprint TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','interrupted')),
 review TEXT NOT NULL, unit TEXT, error TEXT, createdAt TEXT NOT NULL, finishedAt TEXT
);
CREATE UNIQUE INDEX one_preparation ON preparations(checkoutPath) WHERE status='running';
CREATE TABLE recovery_preferences (
 environmentId TEXT PRIMARY KEY REFERENCES environments(id), restore INTEGER NOT NULL DEFAULT 0,
 pendingBoot TEXT, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE retired_instances (
 instanceId TEXT PRIMARY KEY REFERENCES instances(id), retiredAt TEXT NOT NULL
);
CREATE TABLE recovery_operations (
 operationId TEXT PRIMARY KEY REFERENCES operations(id)
);
