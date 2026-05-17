INSERT INTO stages (name, prompt_template_path, input_artifact_type, output_artifact_type, gate, default_backend) VALUES
  ('planner1', 'planner1.md', 'spec',   'plan',  'review_required', 'kbbl_chat'),
  ('planner2', 'planner2.md', 'cohort', 'brief', 'review_required', 'kbbl_chat'),
  ('build',    'build.md',    'brief',  'pr',    'none',            'kbbl_chat');
