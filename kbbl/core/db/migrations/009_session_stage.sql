-- Disambiguate which stage owns the live session_ref so the build guard and UI
-- can tell a planner2 session from a build session. Without this, the cohorts
-- column current_session_ref was overloaded between planner2 and build, causing
-- the manual Run-build button and POST /briefs/:id/build 409 to misfire when
-- planner2's ref hadn't been cleared yet.

ALTER TABLE specs ADD COLUMN current_session_stage TEXT
  CHECK (current_session_stage IS NULL OR current_session_stage IN ('planner1', 'planner2', 'build'));
ALTER TABLE cohorts ADD COLUMN current_session_stage TEXT
  CHECK (current_session_stage IS NULL OR current_session_stage IN ('planner1', 'planner2', 'build'));
