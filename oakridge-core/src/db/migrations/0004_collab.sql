-- Collaboration layer: threaded comments, messages, and materialized review items.
--
-- anchor is an RFC-6901 JSON Pointer into the artifact body (NULL = whole artifact).
-- artifact_id points to the specific revision; revision_id is the chain-root for grouping.

CREATE TABLE IF NOT EXISTS threads (
    id          TEXT NOT NULL PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL,
    anchor      TEXT,
    status      TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id          TEXT NOT NULL PRIMARY KEY,
    thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    body        TEXT NOT NULL,
    author      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS review_items (
    id          TEXT NOT NULL PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
    revision_id TEXT NOT NULL,
    anchor      TEXT NOT NULL,
    claim       TEXT NOT NULL,
    reality     TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'waived')),
    resolution  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS threads_artifact              ON threads(artifact_id);
CREATE INDEX IF NOT EXISTS messages_thread              ON messages(thread_id);
CREATE INDEX IF NOT EXISTS review_items_artifact        ON review_items(artifact_id);
CREATE INDEX IF NOT EXISTS review_items_artifact_status ON review_items(artifact_id, status);
