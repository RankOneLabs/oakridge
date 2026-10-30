-- Existing pinned rows remain untouched; new registrations supply these fields.
ALTER TABLE observation.question_definition
  ADD COLUMN question_text text,
  ADD COLUMN evidence_recipe_provenance jsonb;
ALTER TABLE observation.evaluator_definition
  ADD COLUMN instruction_text text;
