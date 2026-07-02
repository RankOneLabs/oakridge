-- Add optional per-role reasoning-effort selections to epics.
-- NULL = no effort override (the runtime's default), matching standalone
-- sessions. Nullable columns so existing epics keep running at the default;
-- no table rebuild needed since there's no CHECK constraint to add.
ALTER TABLE epics ADD COLUMN planner_effort TEXT;
ALTER TABLE epics ADD COLUMN worker_effort TEXT;
