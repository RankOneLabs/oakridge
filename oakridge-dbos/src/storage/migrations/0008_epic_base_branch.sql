-- One base branch per epic, and one name per branch role.
--
-- `base_branch` on a repository binding meant `main` — where the epic's work
-- eventually merges back — while `epic_branch` meant the branch every build
-- unit's pull request actually targets. Two branches, and the word "base" on
-- the wrong one, so `final-pull-request.ts` and `cohort-pull-request.ts` used
-- the same field name for different branches.
--
-- The roles are named now: `integration_branch` per repository (was
-- `base_branch`), and one `base_branch` per epic (was `epic_branch`, repeated
-- in every binding and free to disagree between them).

ALTER TABLE oakridge.epic_workflow_profile
  ADD COLUMN base_branch text;

-- An epic whose bindings named *different* epic branches cannot be collapsed
-- into one, and the whole point of this migration is that nothing downstream
-- could express which of them a stage meant. Picking the first and dropping the
-- rest would lose branches silently and unrecoverably, so this refuses instead.
--
-- It should never fire: `epic_branch` was optional and defaulted to
-- `epic/<slug>` for every repository, and the launcher never sent it. A launch
-- that set it per repository by hand is the case this catches, and the operator
-- has to say which branch the epic is on before the column can exist.
--
-- An absent `epic_branch` is not "no opinion" — it *meant* `epic/<slug>`, the
-- same default `selectEpicBranch` applied. So it is normalised to that value
-- rather than skipped: a profile holding one absent entry and one explicit
-- non-default entry names two branches, and counting only the explicit ones
-- would let exactly that case through the check it exists for.
DO $$
DECLARE divergent text;
BEGIN
  SELECT string_agg(DISTINCT profile.id::text, ', ') INTO divergent
  FROM oakridge.epic_workflow_profile profile
  WHERE (
    SELECT count(DISTINCT COALESCE(entry->>'epic_branch', 'epic/' || profile.slug))
    FROM jsonb_array_elements(profile.repositories) AS entry
  ) > 1;
  IF divergent IS NOT NULL THEN
    RAISE EXCEPTION
      'epic_workflow_profile rows carry more than one epic_branch and cannot be migrated to a single base branch: %', divergent
      USING HINT = 'Reconcile these epics to one epic_branch per profile, then re-run the migration.';
  END IF;
END $$;

-- With divergence ruled out, any binding's value is the epic's. The slug
-- fallback covers a profile with no repositories at all.
UPDATE oakridge.epic_workflow_profile
SET base_branch = COALESCE(repositories->0->>'epic_branch', 'epic/' || slug);

ALTER TABLE oakridge.epic_workflow_profile
  ALTER COLUMN base_branch SET NOT NULL;

-- `WITH ORDINALITY` and the matching `ORDER BY`: jsonb_agg has no inherent
-- order, and repository order is the order an operator declared them in.
UPDATE oakridge.epic_workflow_profile
SET repositories = COALESCE((
  SELECT jsonb_agg(
           (entry - 'epic_branch' - 'base_branch')
             || jsonb_build_object('integration_branch', COALESCE(entry->>'base_branch', 'main'))
           ORDER BY ord
         )
  FROM jsonb_array_elements(repositories) WITH ORDINALITY AS elements(entry, ord)
), '[]'::jsonb);
