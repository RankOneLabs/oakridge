-- No old-run conversion: deploy into an empty v15 run ledger.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM oakridge.workflow_run)
    OR EXISTS (SELECT 1 FROM oakridge.prompt_bundle) THEN
    RAISE EXCEPTION '0018 requires an empty v15 run and prompt ledger; use a fresh database';
  END IF;
END $$;
ALTER TABLE oakridge.cohort
  ADD COLUMN repository_head_sha text,
  ADD COLUMN pending_repository_head_sha text,
  ADD COLUMN current_verified_pull_request_id uuid REFERENCES dev_flow.pull_request_verification(id)
    DEFERRABLE INITIALLY DEFERRED;
DROP TABLE dev_flow.build_cohort;

-- The pinned bundle mirrors the compiled stage/worker/action references.
ALTER TABLE oakridge.prompt_bundle RENAME COLUMN matrix TO entries;
