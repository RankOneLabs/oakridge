-- One database-owned seed makes work-order capabilities stable across process
-- recovery and concurrent reconcilers without making them derivable from the
-- public run/work-order identifiers. Only the hash of each derived capability
-- is stored beside a work order.
CREATE TABLE oakridge.runtime_secret (
  name text PRIMARY KEY,
  value text NOT NULL CHECK (length(value) >= 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO oakridge.runtime_secret (name, value)
VALUES ('work_order_capability', gen_random_uuid()::text || gen_random_uuid()::text);
