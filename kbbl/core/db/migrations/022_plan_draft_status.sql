-- Add a 'draft' status to plans and default new plans to it.
--
-- The plan_writer agent creates the plan (POST /plans) and then posts cohorts
-- and dependency edges incrementally. Until it finishes, the plan is an
-- incomplete draft — the operator must not be able to approve it. New plans now
-- land in 'draft'; the agent flips them to 'pending_approval' (POST
-- /plans/:id/submit) only once every cohort and dependency is posted. The PWA
-- review queue filters on 'pending_approval', so drafts are neither shown nor
-- approvable.
--
-- SQLite cannot ALTER a CHECK constraint, so rebuild the table. plans is
-- referenced by other tables (cohorts, assessments, briefs) and self-references
-- via predecessor_plan_id, so foreign_keys must be OFF during the swap. The
-- migration runner wraps each file in a transaction and PRAGMA foreign_keys is
-- a no-op inside a transaction, so we COMMIT out first, toggle the pragma, and
-- BEGIN our own — mirroring the 12-step rebuild in migration 016.
COMMIT;
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE plans_new (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','approved','rejected','superseded')),
  predecessor_plan_id TEXT REFERENCES plans(id),
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rejection_reason TEXT,
  current_session_ref TEXT,
  current_session_stage TEXT
);
INSERT INTO plans_new
  SELECT id, spec_id, status, predecessor_plan_id, model, created_at,
         rejection_reason, current_session_ref, current_session_stage
  FROM plans;
DROP INDEX plans_spec_id;
DROP TABLE plans;
ALTER TABLE plans_new RENAME TO plans;
CREATE INDEX plans_spec_id ON plans(spec_id);
COMMIT;
PRAGMA foreign_keys = ON;
BEGIN;
