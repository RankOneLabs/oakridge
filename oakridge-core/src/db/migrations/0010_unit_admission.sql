CREATE TABLE IF NOT EXISTS stage_session_unit_admission (
    stage_instance_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    admitted_at TEXT NOT NULL,
    PRIMARY KEY (stage_instance_id, unit_id),
    FOREIGN KEY (stage_instance_id, unit_id)
        REFERENCES stage_session_units(stage_instance_id, unit_id) ON DELETE CASCADE
);
