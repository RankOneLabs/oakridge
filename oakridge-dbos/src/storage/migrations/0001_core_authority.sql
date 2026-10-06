-- Oakridge authority baseline. Apply only to a new database.
CREATE SCHEMA authority;

CREATE TABLE authority.definition_bundle (
  id text PRIMARY KEY, digest text NOT NULL UNIQUE, source jsonb NOT NULL,
  checked_program jsonb NOT NULL, version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE TABLE authority.run (
  id text PRIMARY KEY, definition_bundle_id text NOT NULL REFERENCES authority.definition_bundle(id),
  created_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE TABLE authority.scope_instance (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES authority.run(id),
  parent_id text REFERENCES authority.scope_instance(id), scope_key text NOT NULL,
  child_key text, collection_key text, input jsonb NOT NULL, local_state jsonb NOT NULL,
  outcome jsonb, is_terminal boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (run_id, id)
);
CREATE UNIQUE INDEX scope_instance_child_identity_idx ON authority.scope_instance
  (parent_id, collection_key, child_key) NULLS NOT DISTINCT WHERE parent_id IS NOT NULL;
CREATE TABLE authority.scope_export (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  export_key text NOT NULL, value jsonb NOT NULL, version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (scope_id, export_key)
);
CREATE TABLE authority.child_collection (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  collection_key text NOT NULL, members jsonb NOT NULL DEFAULT '[]'::jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (scope_id, collection_key),
  CHECK (jsonb_typeof(members) = 'array')
);
CREATE TABLE authority.execution_selection (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  worker_key text NOT NULL, execution_id text, generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (scope_id, worker_key)
);
CREATE TABLE authority.execution (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  worker_key text NOT NULL, generation bigint NOT NULL CHECK (generation >= 0),
  status text NOT NULL, result jsonb, version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (scope_id, worker_key, generation)
);
ALTER TABLE authority.execution_selection ADD CONSTRAINT execution_selection_execution_fk
  FOREIGN KEY (execution_id) REFERENCES authority.execution(id);
CREATE TABLE authority.artifact_revision (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  execution_id text REFERENCES authority.execution(id), output_key text NOT NULL,
  collection_key text, body jsonb NOT NULL, predecessor_id text REFERENCES authority.artifact_revision(id),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE TABLE authority.output_slot (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  output_key text NOT NULL, collection_key text NOT NULL DEFAULT '',
  current_revision_id text REFERENCES authority.artifact_revision(id),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (scope_id, output_key, collection_key)
);
CREATE TABLE authority.fact (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  fact_key text NOT NULL, payload jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE TABLE authority.transition (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  trigger_id text NOT NULL, decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE TABLE authority.ingress_receipt (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES authority.run(id),
  scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  ingress_id text NOT NULL, request_digest text NOT NULL,
  result jsonb NOT NULL, version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (run_id, scope_id, ingress_id)
);
CREATE TABLE authority.effect_intent (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  execution_id text REFERENCES authority.execution(id), effect_key text NOT NULL,
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (scope_id, effect_key)
);
CREATE TABLE authority.capacity_pool (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES authority.run(id),
  pool_key text NOT NULL, capacity integer NOT NULL CHECK (capacity >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (run_id, pool_key)
);
CREATE TABLE authority.capacity_reservation (
  id text PRIMARY KEY, pool_id text NOT NULL REFERENCES authority.capacity_pool(id),
  scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  is_active boolean NOT NULL DEFAULT true, version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (pool_id, scope_id)
);
CREATE TABLE authority.resource_binding (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES authority.scope_instance(id),
  resource_key text NOT NULL, observation jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (scope_id, resource_key)
);
CREATE INDEX scope_instance_run_idx ON authority.scope_instance(run_id);
CREATE INDEX scope_instance_parent_idx ON authority.scope_instance(parent_id);
CREATE INDEX reservation_active_idx ON authority.capacity_reservation(pool_id) WHERE is_active;
