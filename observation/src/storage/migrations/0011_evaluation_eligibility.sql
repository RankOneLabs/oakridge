CREATE TABLE observation.evaluation_eligibility (
  producer text NOT NULL,
  namespace text NOT NULL,
  subject_occurrence_id text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  tag text NOT NULL CHECK (tag IN ('eligible', 'inapplicable', 'missing_evidence', 'invalid_reference', 'blocked_dependency', 'skipped_budget')),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, subject_occurrence_id, question_id, question_version),
  FOREIGN KEY (producer, namespace, subject_occurrence_id) REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, question_id, question_version) REFERENCES observation.question_definition(producer, namespace, question_id, question_version),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (tag <> 'invalid_reference' OR payload->>'kind' IN ('dangling_citation', 'unlinked')),
  CHECK (tag <> 'skipped_budget' OR payload->>'kind' = 'skipped_budget')
);
ALTER TABLE observation.evaluation_eligibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.evaluation_eligibility FORCE ROW LEVEL SECURITY;
CREATE POLICY evaluation_eligibility_tenant ON observation.evaluation_eligibility
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
CREATE TRIGGER evaluation_eligibility_append_only BEFORE UPDATE OR DELETE ON observation.evaluation_eligibility
  FOR EACH ROW EXECUTE FUNCTION observation.reject_grade_mutation();
