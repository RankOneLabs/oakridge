-- Collab layer fixes:
-- 1. revision_id indexes so list/count queries by chain-root are fast.
-- 2. Partial unique index on artifact.parent_artifact_id so concurrent atom-edits
--    racing past the application-level OCC check get rejected at the DB level
--    rather than silently forking the revision chain.

CREATE INDEX IF NOT EXISTS threads_revision      ON threads(revision_id);
CREATE INDEX IF NOT EXISTS review_items_revision ON review_items(revision_id);

-- Two concurrent atom-edits both compute version N+1 before either commits.
-- A (parent_artifact_id, version) unique index lets the emit retry loop
-- recompute a fresh version on conflict (existing behaviour), while the
-- REST post_atom_edit handler — which has no retry loop — gets a unique
-- violation it converts to 409 Conflict.
CREATE UNIQUE INDEX IF NOT EXISTS artifact_parent_version
    ON artifact(parent_artifact_id, version)
    WHERE parent_artifact_id IS NOT NULL;
