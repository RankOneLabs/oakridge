-- Epic is the lifecycle root for a spec. The 1:1 relationship is enforced by
-- UNIQUE(spec_id): each spec has at most one Epic. title is a denormalized copy
-- of spec.title captured at insert time and never updated from spec afterward.
CREATE TABLE epics (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL UNIQUE REFERENCES specs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'complete', 'archived')),
  current_stage TEXT NOT NULL CHECK (current_stage IN ('spec', 'build', 'review')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX epics_project_id_status ON epics(project_id, status);

-- Backfill: one epic per existing spec, deriving status+current_stage from
-- legacy specs.status.
-- draft|plan_review       → active / spec
-- planning_done           → active / build
-- done                    → complete / review
-- archived                → archived / spec
INSERT INTO epics (id, spec_id, project_id, title, status, current_stage, created_at)
  SELECT
    'epic-backfill-' || s.id,
    s.id,
    s.project_id,
    s.title,
    CASE s.status
      WHEN 'done'     THEN 'complete'
      WHEN 'archived' THEN 'archived'
      ELSE                 'active'
    END,
    CASE s.status
      WHEN 'planning_done' THEN 'build'
      WHEN 'done'          THEN 'review'
      ELSE                      'spec'
    END,
    s.created_at
  FROM specs s;
