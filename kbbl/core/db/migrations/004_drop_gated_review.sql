-- The gated-review endpoint is one configured URL for every session, so the
-- adapter-local grant recorded by 003 no longer has a reader.
ALTER TABLE acp_sessions DROP COLUMN gated_review_json;
