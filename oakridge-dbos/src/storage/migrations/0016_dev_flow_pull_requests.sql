-- Adapter-owned build cohort refs and one pull-request model for cohort and
-- final epic pull requests. Observations are append-only; verification and
-- merge closure are separate facts.

CREATE TABLE oakridge.dev_flow_build_cohort (
  cohort_id uuid PRIMARY KEY REFERENCES oakridge.cohort(id) ON DELETE CASCADE,
  stage_instance_id uuid NOT NULL REFERENCES oakridge.stage_instance(id) ON DELETE CASCADE,
  cohort_key text NOT NULL CHECK (length(btrim(cohort_key)) > 0),
  repository_key text NOT NULL CHECK (length(btrim(repository_key)) > 0),
  repository_path text NOT NULL CHECK (length(btrim(repository_path)) > 0),
  canonical_ref text NOT NULL CHECK (length(btrim(canonical_ref)) > 0),
  expected_pr_base text NOT NULL CHECK (length(btrim(expected_pr_base)) > 0),
  recorded_head_sha text NOT NULL CHECK (length(btrim(recorded_head_sha)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stage_instance_id, cohort_key),
  UNIQUE (cohort_id, repository_key)
);

CREATE TABLE oakridge.pull_request (
  id uuid PRIMARY KEY,
  repository_key text NOT NULL CHECK (length(btrim(repository_key)) > 0),
  provider text NOT NULL CHECK (provider = 'github'),
  owner text NOT NULL CHECK (length(btrim(owner)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  forge_pull_request_id bigint NOT NULL CHECK (forge_pull_request_id > 0),
  url text NOT NULL CHECK (length(btrim(url)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_key, forge_pull_request_id)
);

CREATE TABLE oakridge.pull_request_observation (
  id uuid PRIMARY KEY,
  pull_request_id uuid NOT NULL REFERENCES oakridge.pull_request(id) ON DELETE CASCADE,
  head_ref text NOT NULL CHECK (length(btrim(head_ref)) > 0),
  base_ref text NOT NULL CHECK (length(btrim(base_ref)) > 0),
  head_sha text CHECK (head_sha IS NULL OR length(btrim(head_sha)) > 0),
  state text NOT NULL CHECK (state IN ('open', 'merged', 'closed_unmerged')),
  source text NOT NULL CHECK (source IN ('poll', 'webhook', 'manual_recheck')),
  observed_at timestamptz NOT NULL,
  merged_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'merged') = (merged_at IS NOT NULL))
);
CREATE INDEX pull_request_observation_history_idx
  ON oakridge.pull_request_observation (pull_request_id, observed_at DESC, id);

CREATE TABLE oakridge.pull_request_verification (
  id uuid PRIMARY KEY,
  cohort_id uuid NOT NULL REFERENCES oakridge.cohort(id) ON DELETE CASCADE,
  pull_request_id uuid NOT NULL REFERENCES oakridge.pull_request(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL REFERENCES oakridge.pull_request_observation(id) ON DELETE RESTRICT,
  verified_head_sha text NOT NULL CHECK (length(btrim(verified_head_sha)) > 0),
  verified_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  invalidation_reason text CHECK (invalidation_reason IN ('replaced', 'head_changed')),
  CHECK ((invalidated_at IS NULL) = (invalidation_reason IS NULL))
);
CREATE UNIQUE INDEX pull_request_one_current_verified_per_cohort_idx
  ON oakridge.pull_request_verification (cohort_id)
  WHERE invalidated_at IS NULL;

ALTER TABLE oakridge.dev_flow_build_cohort
  ADD COLUMN current_verified_pull_request_id uuid,
  ADD CONSTRAINT dev_flow_build_cohort_current_verified_fk
    FOREIGN KEY (current_verified_pull_request_id)
    REFERENCES oakridge.pull_request_verification(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE oakridge.pull_request_merge_closure (
  id uuid PRIMARY KEY,
  cohort_id uuid NOT NULL UNIQUE REFERENCES oakridge.cohort(id) ON DELETE CASCADE,
  pull_request_id uuid NOT NULL REFERENCES oakridge.pull_request(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE CHECK (length(btrim(idempotency_key)) > 0),
  merged_at timestamptz NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now()
);

-- Approvals name the verified head they reviewed. Replacing a PR invalidates
-- those facts in the same transaction as the current-link transition.
CREATE TABLE oakridge.pull_request_approval (
  id uuid PRIMARY KEY,
  cohort_id uuid NOT NULL REFERENCES oakridge.cohort(id) ON DELETE CASCADE,
  verification_id uuid NOT NULL REFERENCES oakridge.pull_request_verification(id) ON DELETE CASCADE,
  approval_kind text NOT NULL CHECK (approval_kind IN ('build_review', 'assessment_review')),
  approved_at timestamptz NOT NULL,
  invalidated_at timestamptz,
  UNIQUE (cohort_id, approval_kind, verification_id)
);

DROP TABLE IF EXISTS oakridge.cohort_pull_request_reconciliation;
DROP TABLE IF EXISTS oakridge.final_pull_request_reconciliation;

-- 0008 moved the per-repository build target onto the epic profile. Build
-- targets now live on dev_flow_build_cohort; the profile retains only final
-- integration configuration and is never consulted by core.
ALTER TABLE IF EXISTS oakridge.epic_workflow_profile
  DROP COLUMN IF EXISTS base_branch;
