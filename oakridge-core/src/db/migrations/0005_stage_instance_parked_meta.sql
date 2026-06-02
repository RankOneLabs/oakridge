-- Structured park metadata attached by an executor while a stage is parked
-- (e.g. the session_agent approval request_id). JSON-encoded, nullable.
ALTER TABLE stage_instance ADD COLUMN parked_meta TEXT;
