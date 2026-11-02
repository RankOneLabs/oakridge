-- Langfuse is removed. Grading is local: this drops the 0008 sync tables with their triggers,
-- policies and functions, and the imported-annotation exemptions 0009, 0013 and 0014 carved out
-- of grade provenance and the blind-collection check. A blind grade now always names a claimed
-- assignment.
--
-- Rebuilding label_origin and the collection check would silently reclassify or reject any grade
-- recorded under a Langfuse annotation evaluator, so refuse to run if one exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM observation.grade_observation
    WHERE evaluator_definition_id IN ('langfuse-annotation-human', 'langfuse-annotation-human/v2')) THEN
    RAISE EXCEPTION 'grades recorded under a Langfuse annotation evaluator exist; resolve them before dropping Langfuse';
  END IF;
END $$;

DROP TABLE observation.langfuse_inbound_quarantine;
DROP TABLE observation.langfuse_sync_transition;
DROP TABLE observation.langfuse_mapping;
DROP FUNCTION observation.guard_langfuse_mapping_mutation();
DROP FUNCTION observation.record_langfuse_sync_transition();
DROP FUNCTION observation.reject_langfuse_history_mutation();

ALTER TABLE observation.grade_observation DROP COLUMN label_origin;
ALTER TABLE observation.grade_observation ADD COLUMN label_origin text GENERATED ALWAYS AS (
  CASE
    WHEN question_id LIKE 'oakridge-review:%' AND question_version = '1'
      AND evaluator_definition_id = 'oakridge-operator-human'
      AND reviewer_id = 'oakridge-operator' THEN 'oakridge_operator_unblinded'
    ELSE 'other'
  END
) STORED;

ALTER TABLE observation.grade_observation DROP CONSTRAINT grade_collection_consistency;
ALTER TABLE observation.grade_observation
  ADD CONSTRAINT grade_collection_consistency CHECK (
    collection_mode IS NULL OR
    (model_answers_visible IS NOT NULL AND workflow_decisions_visible IS NOT NULL AND
      (collection_mode <> 'blind' OR (blind_assignment_id IS NOT NULL
        AND NOT model_answers_visible AND NOT workflow_decisions_visible))));
