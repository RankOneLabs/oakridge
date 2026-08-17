-- A workflow attempt's domain outcome, recorded when its run workflow ends.
--
-- DBOS's own workflow_status tells us whether an attempt is still *alive*; it
-- cannot tell us whether the work *succeeded*, because productionRunWorkflow
-- returns failure and cancellation as ordinary values and DBOS records those
-- returns as SUCCESS. Projections that read only dbos_status therefore show a
-- failed run as complete. Persisting the outcome here gives them a result axis
-- to join against, and keeps the projection off DBOS internals.
--
-- Outcome lives on the attempt, not the run: a rerun forks a new attempt root
-- and projections read the newest attempt, so a run-level column would report
-- the previous attempt's failure while the current one is still running.
ALTER TABLE oakridge.workflow_attempt
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN outcome jsonb,
  ADD CONSTRAINT workflow_attempt_outcome_consistent
    CHECK ((ended_at IS NULL) = (outcome IS NULL));
