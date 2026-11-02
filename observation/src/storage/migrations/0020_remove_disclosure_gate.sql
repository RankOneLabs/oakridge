ALTER TABLE observation.grading_job DROP COLUMN disclosure;
ALTER TABLE observation.grading_job DROP CONSTRAINT grading_job_terminal_cause_check;
ALTER TABLE observation.grading_job ADD CONSTRAINT grading_job_terminal_cause_check
  CHECK (terminal_cause IS NULL OR terminal_cause IN
    ('retry_exhausted', 'runner_failed', 'invalid_outcome', 'ineligible', 'budget_exceeded'));
