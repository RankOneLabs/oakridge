-- Persist the session's permission mode (the agent's `mode` config option).
--
-- The agent holds its mode in process memory, so a respawn — idle TTL,
-- kbbl restart — comes back in the agent's settings default ("Manual" for
-- Claude Code) and every Bash/Edit starts prompting again. `requested_mode`
-- is seeded from the agent profile's `session_mode` at create, rewritten
-- when the operator changes the mode from the session bar, and re-applied
-- on every spawn, the same way requested_model/requested_effort are.
-- NULL leaves the agent's own default in place.

ALTER TABLE acp_sessions ADD COLUMN requested_mode TEXT;
