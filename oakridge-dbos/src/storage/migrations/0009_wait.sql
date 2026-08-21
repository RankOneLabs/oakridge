CREATE TABLE oakridge.wait (
  id                    uuid PRIMARY KEY,
  stage_instance_id     uuid NOT NULL REFERENCES oakridge.stage_instance(id) ON DELETE CASCADE,
  unit_id               text NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('gate','handoff_downstream','handoff_external')),
  artifact_revision_id  uuid NOT NULL REFERENCES oakridge.artifact(id) ON DELETE CASCADE,
  closes_on             jsonb NOT NULL,
  status                text NOT NULL CHECK (status IN ('open','closed')),
  outcome               jsonb,
  execution_workflow_id text NOT NULL,
  command_workflow_id   text NOT NULL,
  opened_at             timestamptz NOT NULL,
  closed_at             timestamptz,
  CHECK ((status = 'closed') = (outcome IS NOT NULL)),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (closes_on->>'kind' = kind),
  -- Backs wait_open_identity's coalesce: a gate row without a gate_step would
  -- key as '' and collide with nothing meaningful — refuse it at write time.
  CHECK (kind <> 'gate' OR closes_on->>'gate_step' IS NOT NULL)
);

-- One row per (answering workflow, kind). Open/close key on this — that is
-- the whole replay-idempotency story. Safe because a gate workflow owns one
-- gate wait and a handoff workflow one row of each handoff kind, for its
-- whole life; sequential gate steps are separate workflows, so no collision.
CREATE UNIQUE INDEX wait_command_identity ON oakridge.wait (command_workflow_id, kind);

-- At most one OPEN wait per (artifact, kind, step) — the tripwire for a
-- second workflow opening a wait on a revision another workflow already
-- holds open: its open step fails loudly instead of double-recording.
-- Retried opens never trip it: ON CONFLICT pre-checks its arbiter
-- (command_workflow_id, kind) and skips the insert before any other index
-- sees the row.
CREATE UNIQUE INDEX wait_open_identity ON oakridge.wait
  (artifact_revision_id, kind, coalesce(closes_on->>'gate_step', ''))
  WHERE status = 'open';

CREATE INDEX wait_by_artifact ON oakridge.wait (artifact_revision_id, kind);
