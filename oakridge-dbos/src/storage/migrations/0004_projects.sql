CREATE TABLE oakridge.project (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  repo_dir text NOT NULL,
  forge_repository jsonb,
  base_branch text,
  created_at timestamptz NOT NULL
);

ALTER TABLE oakridge.workflow_run
  ADD CONSTRAINT workflow_run_project_id_fkey
  FOREIGN KEY (project_id) REFERENCES oakridge.project(id);
