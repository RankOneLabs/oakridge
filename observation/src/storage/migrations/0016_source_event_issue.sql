CREATE TABLE observation.source_event_issue (
  producer text NOT NULL,
  namespace text NOT NULL,
  issue_id text NOT NULL,
  event_id text NOT NULL,
  run_id text NOT NULL,
  event_kind text NOT NULL,
  target_revision_id text,
  cause text NOT NULL CHECK (cause IN ('missing_grade_target', 'missing_collaboration_revision', 'run_mismatch', 'unmapped_event', 'revision_identity_conflict', 'tenant_mismatch')),
  original_outcome jsonb NOT NULL,
  resolution_state text NOT NULL DEFAULT 'unresolved' CHECK (resolution_state IN ('unresolved', 'resolved')),
  resolution_detail text,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  PRIMARY KEY (producer, namespace, issue_id)
);
CREATE INDEX source_event_issue_target ON observation.source_event_issue(producer, namespace, target_revision_id)
  WHERE resolution_state = 'unresolved';
ALTER TABLE observation.source_event_issue ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.source_event_issue FORCE ROW LEVEL SECURITY;
CREATE POLICY source_event_issue_tenant ON observation.source_event_issue
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
