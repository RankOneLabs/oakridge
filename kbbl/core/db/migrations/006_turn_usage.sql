-- One usage outcome per terminal turn; absent counters remain NULL.
CREATE TABLE acp_turn_usage (
  sid TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reported','partial','absent')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_read_tokens INTEGER,
  cached_write_tokens INTEGER,
  thought_tokens INTEGER,
  total_tokens INTEGER,
  -- Array of {model, input_tokens, output_tokens, cached_read_tokens, cached_write_tokens, thought_tokens}.
  model_usage_json TEXT,
  -- Agent usage and _meta.quota verbatim.
  raw_json TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (sid, turn_key),
  FOREIGN KEY (sid, turn_key) REFERENCES acp_turns(sid, turn_key) ON DELETE CASCADE
);
CREATE TABLE acp_usage_reading (
  sid TEXT NOT NULL REFERENCES acp_sessions(sid) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  -- Cumulative cost counters restart with each agent process.
  process_seq INTEGER NOT NULL,
  context_used INTEGER,
  context_size INTEGER,
  cost_amount REAL,
  cost_currency TEXT,
  -- NULL between turns.
  active_turn_key TEXT,
  autonomous INTEGER NOT NULL DEFAULT 0,
  origin_kind TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (sid, seq)
);
