ALTER TABLE observation.grade_observation
  ADD COLUMN collection_mode text CHECK (collection_mode IN ('blind', 'in_context')),
  ADD COLUMN blind_assignment_id text,
  ADD COLUMN model_answers_visible boolean,
  ADD COLUMN workflow_decisions_visible boolean;

CREATE TABLE observation.blind_assignment (
  producer text NOT NULL,
  namespace text NOT NULL,
  assignment_id text NOT NULL,
  subject_occurrence_id text NOT NULL,
  evidence_set_id text NOT NULL,
  question_id text NOT NULL,
  question_version text NOT NULL,
  claim_owner text,
  claimed_at timestamptz,
  expires_at timestamptz,
  submitted_observation_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (producer, namespace, assignment_id),
  UNIQUE (producer, namespace, subject_occurrence_id, question_id, question_version),
  FOREIGN KEY (producer, namespace, subject_occurrence_id) REFERENCES observation.item_occurrence(producer, namespace, occurrence_id),
  FOREIGN KEY (producer, namespace, evidence_set_id) REFERENCES observation.evidence_set(producer, namespace, evidence_set_id),
  FOREIGN KEY (producer, namespace, question_id, question_version) REFERENCES observation.question_definition(producer, namespace, question_id, question_version),
  FOREIGN KEY (producer, namespace, submitted_observation_id) REFERENCES observation.grade_observation(producer, namespace, observation_id),
  CHECK ((claim_owner IS NULL) = (claimed_at IS NULL AND expires_at IS NULL)),
  CHECK (submitted_observation_id IS NULL OR claim_owner IS NOT NULL),
  CHECK (expires_at IS NULL OR expires_at > claimed_at)
);
ALTER TABLE observation.grade_observation
  ADD CONSTRAINT grade_blind_assignment_ref FOREIGN KEY (producer, namespace, blind_assignment_id)
    REFERENCES observation.blind_assignment(producer, namespace, assignment_id),
  ADD CONSTRAINT grade_collection_consistency CHECK (
    collection_mode IS NULL OR
    (model_answers_visible IS NOT NULL AND workflow_decisions_visible IS NOT NULL AND
      (collection_mode <> 'blind' OR ((blind_assignment_id IS NOT NULL OR evaluator_definition_id = 'langfuse-annotation-human')
        AND NOT model_answers_visible AND NOT workflow_decisions_visible))));
ALTER TABLE observation.blind_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE observation.blind_assignment FORCE ROW LEVEL SECURITY;
CREATE POLICY blind_assignment_tenant ON observation.blind_assignment
  USING (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true))
  WITH CHECK (producer = current_setting('observation.producer', true) AND namespace = current_setting('observation.namespace', true));
