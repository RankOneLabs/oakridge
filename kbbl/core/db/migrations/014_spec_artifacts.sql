-- Add spec artifact columns: submitted_notes (immutable snapshot of notes at
-- insert time), final_notes, and internal_status (Spec-stage state machine).
ALTER TABLE specs ADD COLUMN submitted_notes TEXT;
ALTER TABLE specs ADD COLUMN final_notes TEXT;
ALTER TABLE specs ADD COLUMN internal_status TEXT NOT NULL DEFAULT 'analyzing'
  CHECK (internal_status IN ('analyzing', 'discrepancies', 'review', 'approved'));

-- Backfill internal_status: planning_done|done specs are past the discrepancy
-- loop and already approved; everything else starts at analyzing.
UPDATE specs
  SET internal_status = 'approved'
  WHERE status IN ('planning_done', 'done');

-- spec_discrepancies tracks mismatches between what the spec assumed and what
-- the build agent actually produced.
CREATE TABLE spec_discrepancies (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  spec_assumption TEXT NOT NULL,
  code_reality TEXT NOT NULL,
  resolution TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'waived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX spec_discrepancies_spec_id ON spec_discrepancies(spec_id);
