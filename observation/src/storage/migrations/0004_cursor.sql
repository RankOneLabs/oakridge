CREATE TABLE observation.source_event_cursor (
  producer text NOT NULL,
  namespace text NOT NULL,
  commit_txid bigint NOT NULL DEFAULT 0,
  event_id text NOT NULL DEFAULT '',
  PRIMARY KEY (producer, namespace)
);

CREATE TABLE observation.source_event_outcome (
  producer text NOT NULL,
  namespace text NOT NULL,
  event_id text NOT NULL,
  run_id text NOT NULL,
  commit_txid bigint NOT NULL,
  event_kind text NOT NULL,
  outcome_kind text NOT NULL,
  detail jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, event_id)
);

CREATE TABLE observation.source_human_grade (
  producer text NOT NULL,
  namespace text NOT NULL,
  event_id text NOT NULL,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  review text NOT NULL,
  decision text NOT NULL,
  target_revision_id text NOT NULL,
  evaluator_kind text NOT NULL CHECK (evaluator_kind = 'human'),
  feedback jsonb,
  PRIMARY KEY (producer, namespace, event_id),
  FOREIGN KEY (producer, namespace, event_id) REFERENCES observation.source_event_outcome(producer, namespace, event_id)
);

ALTER TABLE observation.source_event_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.source_event_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY source_event_cursor_tenant ON observation.source_event_cursor
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
ALTER TABLE observation.source_event_outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.source_event_outcome FORCE ROW LEVEL SECURITY;
CREATE POLICY source_event_outcome_tenant ON observation.source_event_outcome
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
ALTER TABLE observation.source_human_grade ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.source_human_grade FORCE ROW LEVEL SECURITY;
CREATE POLICY source_human_grade_tenant ON observation.source_human_grade
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
