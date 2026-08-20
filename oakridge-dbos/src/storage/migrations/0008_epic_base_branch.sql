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

-- Existing epics agree with themselves in practice — `epic_branch` defaulted to
-- `epic/<slug>` for every repository — so the first binding is the epic's
-- branch. The slug fallback covers a profile with no repositories at all.
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
