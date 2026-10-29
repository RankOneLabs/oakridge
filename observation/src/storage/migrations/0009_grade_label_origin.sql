-- Derive provenance from the immutable grading identity, including rows written before this migration.
ALTER TABLE observation.grade_observation ADD COLUMN label_origin text GENERATED ALWAYS AS (
  CASE
    WHEN question_id LIKE 'oakridge-review:%' AND question_version = '1'
      AND evaluator_definition_id = 'oakridge-operator-human'
      AND reviewer_id = 'oakridge-operator' THEN 'oakridge_operator_unblinded'
    WHEN evaluator_definition_id = 'langfuse-annotation-human' THEN 'langfuse_annotation_blinded'
    ELSE 'other'
  END
) STORED;
