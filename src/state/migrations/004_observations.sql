CREATE TABLE checks (
  subject TEXT NOT NULL, kind TEXT NOT NULL, ok INTEGER, status TEXT,
  at TEXT NOT NULL, checkoutId TEXT NOT NULL
);
CREATE INDEX checks_subject ON checks(subject, kind);
CREATE INDEX checks_checkout ON checks(checkoutId);
CREATE TABLE events (
  at TEXT NOT NULL, projectId TEXT NOT NULL, checkoutId TEXT,
  kind TEXT NOT NULL, text TEXT NOT NULL, ref TEXT
);
CREATE INDEX events_project ON events(projectId);
