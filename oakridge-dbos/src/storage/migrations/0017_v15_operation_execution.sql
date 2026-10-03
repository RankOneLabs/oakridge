-- Operation actions share durable intent ownership, but have no agent settings,
-- prompt or session. Their completion is recorded independently of agent exit.
ALTER TABLE oakridge.execution_intent
  ALTER COLUMN prompt DROP NOT NULL,
  ALTER COLUMN settings DROP NOT NULL,
  ADD COLUMN operation text CHECK (operation = 'provision_repository_refs'),
  ADD COLUMN operation_outcome jsonb;
ALTER TABLE oakridge.execution_intent ADD CONSTRAINT execution_intent_action_kind CHECK (
  (worker = 'provision' AND operation = 'provision_repository_refs'
    AND prompt IS NULL AND settings IS NULL AND session_id IS NULL)
  OR (worker <> 'provision' AND operation IS NULL AND prompt IS NOT NULL AND settings IS NOT NULL)
);
ALTER TABLE oakridge.stage_instance ADD COLUMN initialized_at timestamptz;
ALTER TABLE oakridge.cohort ADD COLUMN materialization_position integer CHECK (materialization_position >= 0);

-- Each immutable revision retains the review state last assigned while it was current.
ALTER TABLE oakridge.artifact ADD COLUMN acceptance_state text NOT NULL DEFAULT 'unreviewed'
  CHECK (acceptance_state IN ('unreviewed','accepted','changes_requested'));
