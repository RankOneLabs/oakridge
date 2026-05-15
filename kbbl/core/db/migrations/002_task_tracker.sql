CREATE TABLE specs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','plan_review','planning_done','done','archived')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL REFERENCES specs(id),
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','rejected','superseded')),
  predecessor_plan_id TEXT REFERENCES plans(id),
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE cohorts (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  title TEXT NOT NULL,
  notes TEXT,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','planned','briefing','brief_review','building','done','blocked')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE cohort_dependencies (
  id TEXT PRIMARY KEY,
  from_cohort_id TEXT NOT NULL REFERENCES cohorts(id),
  to_cohort_id TEXT NOT NULL REFERENCES cohorts(id),
  UNIQUE(from_cohort_id, to_cohort_id),
  CHECK (from_cohort_id <> to_cohort_id)
);

CREATE TABLE briefs (
  id TEXT PRIMARY KEY,
  cohort_id TEXT NOT NULL REFERENCES cohorts(id),
  status TEXT NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','rejected','superseded')),
  predecessor_brief_id TEXT REFERENCES briefs(id),
  model TEXT,
  goal TEXT NOT NULL,
  files_in_scope TEXT NOT NULL DEFAULT '[]',
  decisions_made TEXT NOT NULL DEFAULT '[]',
  approaches_rejected TEXT NOT NULL DEFAULT '[]',
  next_action TEXT NOT NULL DEFAULT '',
  debrief TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX cohorts_plan_id ON cohorts(plan_id);
CREATE INDEX cohort_dependencies_from_cohort_id ON cohort_dependencies(from_cohort_id);
CREATE INDEX cohort_dependencies_to_cohort_id ON cohort_dependencies(to_cohort_id);
CREATE INDEX briefs_cohort_id ON briefs(cohort_id);
CREATE INDEX plans_spec_id ON plans(spec_id);
