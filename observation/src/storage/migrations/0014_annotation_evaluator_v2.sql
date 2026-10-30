-- The imported-annotation evaluator gained a versioned id. v1 rows written before 0010 hold the
-- literal config string as their prompt digest and no instruction text, and 0010 leaves them
-- untouched, so new imports register under 'langfuse-annotation-human/v2' rather than conflict.
-- label_origin keys on that id, so it must recognise both. Rebuilding the stored column
-- reclassifies no existing row: a v1 observation still matches the v1 id.
ALTER TABLE observation.grade_observation DROP COLUMN label_origin;
ALTER TABLE observation.grade_observation ADD COLUMN label_origin text GENERATED ALWAYS AS (
  CASE
    WHEN question_id LIKE 'oakridge-review:%' AND question_version = '1'
      AND evaluator_definition_id = 'oakridge-operator-human'
      AND reviewer_id = 'oakridge-operator' THEN 'oakridge_operator_unblinded'
    WHEN evaluator_definition_id IN ('langfuse-annotation-human', 'langfuse-annotation-human/v2')
      THEN 'langfuse_annotation_blinded'
    ELSE 'other'
  END
) STORED;

-- 0013's blind-collection check hardcodes the same id: an imported annotation is blind without
-- a claimed assignment, because its blinding happened in the Langfuse queue. Both ids qualify.
ALTER TABLE observation.grade_observation DROP CONSTRAINT grade_collection_consistency;
ALTER TABLE observation.grade_observation
  ADD CONSTRAINT grade_collection_consistency CHECK (
    collection_mode IS NULL OR
    (model_answers_visible IS NOT NULL AND workflow_decisions_visible IS NOT NULL AND
      (collection_mode <> 'blind' OR ((blind_assignment_id IS NOT NULL
        OR evaluator_definition_id IN ('langfuse-annotation-human', 'langfuse-annotation-human/v2'))
        AND NOT model_answers_visible AND NOT workflow_decisions_visible))));
