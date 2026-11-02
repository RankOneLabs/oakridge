CREATE TABLE observation.source_repair_position (
  producer text NOT NULL,
  namespace text NOT NULL,
  commit_txid bigint NOT NULL DEFAULT 0,
  event_id text NOT NULL DEFAULT '',
  completed_through_txid bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace)
);
ALTER TABLE observation.source_repair_position ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.source_repair_position FORCE ROW LEVEL SECURITY;
CREATE POLICY source_repair_position_tenant ON observation.source_repair_position
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
