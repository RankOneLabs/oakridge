ALTER TABLE observation.question_definition ADD COLUMN unclear_value text;
ALTER TABLE observation.question_definition ADD CONSTRAINT question_unclear_value_allowed CHECK (
  unclear_value IS NULL OR (response_kind = 'choice' AND allowed_values ? unclear_value)
);
