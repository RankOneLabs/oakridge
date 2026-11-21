-- The agent's own display name for the model option kbbl applied to this
-- session (SessionConfigSelectOption.name). A reloaded Claude session
-- advertises the concrete id its transcript ran on (`claude-fable-5-2`)
-- instead of the alias it was created with (`fable`); the name is the same
-- on both sides, so a reload matches on it. NULL when no model was requested.
ALTER TABLE acp_sessions ADD COLUMN applied_model_name TEXT;
