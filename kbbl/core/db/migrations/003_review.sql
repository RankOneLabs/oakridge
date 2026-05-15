CREATE TABLE atom_edits (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  anchor TEXT,
  prior_value TEXT,
  new_value TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE comment_threads (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  anchor TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  author TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE thread_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE frozen_artifacts (
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  frozen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (target_type, target_id)
);

CREATE INDEX atom_edits_type_id_anchor ON atom_edits(target_type, target_id, anchor);
CREATE INDEX atom_edits_type_id_created_at ON atom_edits(target_type, target_id, created_at);
CREATE INDEX comment_threads_type_id ON comment_threads(target_type, target_id);
CREATE INDEX thread_messages_thread_id_created_at ON thread_messages(thread_id, created_at);
