-- Pin the declared gated-review grant to the adapter-local session identity.
ALTER TABLE acp_sessions ADD COLUMN gated_review_json TEXT;
