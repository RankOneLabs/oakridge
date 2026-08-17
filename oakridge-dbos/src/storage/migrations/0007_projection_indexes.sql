-- Indexes and a stored chain_id for the three read paths that ran unindexed.
--
-- 1. The command outbox is polled every second by two dispatchers, and no index
--    covered the predicate they filter on. Every poll was a sequential scan of a
--    table whose delivered rows are never removed, so the scan grew for the life
--    of the deployment. The partial indexes cover only undelivered rows, which
--    is the whole of what a poller ever looks at, and stay small because that
--    set is bounded by in-flight work rather than by history.
--
--    The second index exists for the correlated NOT EXISTS that enforces
--    per-target ordering: without it, each candidate row triggered its own scan.
CREATE INDEX command_outbox_pending_idx
  ON oakridge.command_outbox (command_type, next_attempt_at, sequence_id)
  WHERE delivered_at IS NULL;

CREATE INDEX command_outbox_pending_target_idx
  ON oakridge.command_outbox (command_type, target_workflow_id, sequence_id)
  WHERE delivered_at IS NULL;

--    Delivered rows are purged on a retention window rather than kept forever,
--    and this index serves that sweep — the partial indexes above deliberately
--    cover only the undelivered set.
CREATE INDEX command_outbox_delivered_at_idx
  ON oakridge.command_outbox (delivered_at)
  WHERE delivered_at IS NOT NULL;

-- 2. The operator invalidation cursor is seven max() reads. Six are over tables
--    we own, and none of those columns was indexed, so producing one cursor meant
--    six full scans. A btree's rightmost leaf answers max() directly.
CREATE INDEX artifact_lifecycle_updated_at_idx ON oakridge.artifact (lifecycle_updated_at);
CREATE INDEX gate_decision_audit_created_at_idx ON oakridge.gate_decision_audit (created_at);
CREATE INDEX executor_projection_updated_at_idx ON oakridge.executor_projection (updated_at);
CREATE INDEX epic_workflow_profile_updated_at_idx ON oakridge.epic_workflow_profile (updated_at);
CREATE INDEX collaboration_message_created_at_idx ON oakridge.collaboration_message (created_at);
CREATE INDEX review_item_created_at_idx ON oakridge.review_item (created_at);

-- 3. chain_id is the root of an artifact's revision chain. It is immutable from
--    the moment a revision is inserted — the parent link never changes — but it
--    was recomputed by a per-row recursive CTE on every single artifact read,
--    including four times inside emit_revision's transaction while that
--    transaction holds its advisory lock.
--
--    Stored as a real column, set at insert from the parent's own chain_id.
ALTER TABLE oakridge.artifact ADD COLUMN chain_id uuid;

WITH RECURSIVE ancestry AS (
  SELECT id, id AS root FROM oakridge.artifact WHERE parent_artifact_id IS NULL
  UNION ALL
  SELECT child.id, ancestry.root
  FROM oakridge.artifact child
  JOIN ancestry ON child.parent_artifact_id = ancestry.id
)
UPDATE oakridge.artifact target SET chain_id = ancestry.root
FROM ancestry WHERE target.id = ancestry.id;

ALTER TABLE oakridge.artifact ALTER COLUMN chain_id SET NOT NULL;

CREATE INDEX artifact_chain_id_idx ON oakridge.artifact (chain_id);
