-- Durable operator gate-decision requests and their application status.
--
-- `artifact_chain_id` identifies the root of the review chain while
-- `artifact_revision_id` identifies the exact immutable revision reviewed.
-- `idempotency_key` is supplied by the decision boundary so a retried request cannot
-- append a second audit entry. Audit rows share the owning run/artifact lifecycle:
-- all foreign keys deliberately cascade so deleting a run or artifact chain cannot
-- leave misleading orphaned audit records.

CREATE TABLE gate_decision_audit (
    id                   TEXT NOT NULL PRIMARY KEY,
    run_id               TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
    stage_instance_id    TEXT NOT NULL REFERENCES stage_instance(id) ON DELETE CASCADE,
    unit_id              TEXT NOT NULL,
    artifact_chain_id    TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
    artifact_revision_id TEXT NOT NULL REFERENCES artifact(id) ON DELETE CASCADE,
    gate_step             TEXT NOT NULL,
    action                TEXT NOT NULL,
    operator_comment      TEXT,
    feedback              TEXT,
    status                TEXT NOT NULL CHECK (status IN ('pending', 'applied')),
    created_at            TEXT NOT NULL,
    applied_at            TEXT,
    idempotency_key       TEXT NOT NULL UNIQUE
);

CREATE INDEX gate_decision_audit_run_created
    ON gate_decision_audit(run_id, created_at, id);
CREATE INDEX gate_decision_audit_stage_unit
    ON gate_decision_audit(stage_instance_id, unit_id, created_at, id);
