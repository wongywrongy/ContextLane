CREATE TABLE approvals (
 id TEXT PRIMARY KEY, projectPath TEXT NOT NULL, recipeHash TEXT NOT NULL,
 toolchainRevision TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
 requestedAt TEXT NOT NULL, decidedAt TEXT, decidedBy TEXT, preview TEXT NOT NULL,
 UNIQUE(projectPath,recipeHash,toolchainRevision)
);
CREATE TABLE instances (
 id TEXT PRIMARY KEY, projectPath TEXT NOT NULL, checkoutPath TEXT NOT NULL,
 approvalId TEXT NOT NULL REFERENCES approvals(id), allocations TEXT NOT NULL
);
CREATE TABLE recipe_requests (id TEXT PRIMARY KEY, path TEXT NOT NULL, instanceId TEXT NOT NULL REFERENCES instances(id), recipeHash TEXT NOT NULL, toolchainRevision TEXT NOT NULL);
ALTER TABLE reservations RENAME TO old_reservations;
CREATE TABLE reservations (
 key TEXT PRIMARY KEY, resource TEXT REFERENCES resources(id), preview TEXT REFERENCES previews(id),
 instance TEXT REFERENCES instances(id),
 CHECK((resource IS NOT NULL)+(preview IS NOT NULL)+(instance IS NOT NULL)=1)
);
INSERT INTO reservations(key,resource,preview) SELECT key,resource,preview FROM old_reservations;
DROP TABLE old_reservations;
