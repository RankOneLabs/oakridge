-- New authority; retained oakridge and dev_flow schemas are read-only cutover sources.
CREATE SCHEMA IF NOT EXISTS oakridge_replacement;

CREATE TABLE oakridge_replacement.definition_bundle (
  digest text PRIMARY KEY, checked_bundle jsonb NOT NULL, content_pins jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oakridge_replacement.run (
  id uuid PRIMARY KEY, bundle_digest text NOT NULL REFERENCES oakridge_replacement.definition_bundle(digest),
  root_scope_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz, deleted_at timestamptz
);
CREATE TABLE oakridge_replacement.scope_instance (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES oakridge_replacement.run(id),
  parent_id uuid REFERENCES oakridge_replacement.scope_instance(id), template_key text NOT NULL,
  input jsonb NOT NULL, terminal_outcome jsonb,
  UNIQUE (run_id,id)
);
ALTER TABLE oakridge_replacement.run ADD CONSTRAINT run_root_scope_fk
  FOREIGN KEY (id,root_scope_id) REFERENCES oakridge_replacement.scope_instance(run_id,id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE oakridge_replacement.scope_export (
  scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id), key text NOT NULL,
  value jsonb NOT NULL, version bigint NOT NULL CHECK (version > 0),
  PRIMARY KEY (scope_id,key)
);
CREATE TABLE oakridge_replacement.child_collection (
  id uuid PRIMARY KEY, parent_scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id),
  template_key text NOT NULL, members jsonb NOT NULL, version bigint NOT NULL CHECK (version >= 0),
  UNIQUE (parent_scope_id,template_key)
);
CREATE TABLE oakridge_replacement.execution (
  id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id),
  operation_key text NOT NULL, invocation jsonb NOT NULL, provider_binding jsonb NOT NULL,
  observed jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oakridge_replacement.execution_selection (
  scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id), worker_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 0),
  execution_id uuid REFERENCES oakridge_replacement.execution(id),
  PRIMARY KEY (scope_id,worker_key)
);
CREATE TABLE oakridge_replacement.artifact_revision (
  id uuid PRIMARY KEY, chain_id uuid NOT NULL, revision bigint NOT NULL CHECK (revision > 0),
  predecessor_id uuid REFERENCES oakridge_replacement.artifact_revision(id),
  bundle_digest text NOT NULL REFERENCES oakridge_replacement.definition_bundle(digest),
  body jsonb NOT NULL, provenance jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id,revision)
);
CREATE TABLE oakridge_replacement.output_slot (
  scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id), worker_key text NOT NULL,
  output_key text NOT NULL, collection_key text NOT NULL,
  revision_id uuid NOT NULL REFERENCES oakridge_replacement.artifact_revision(id),
  PRIMARY KEY (scope_id,worker_key,output_key,collection_key)
);
CREATE TABLE oakridge_replacement.fact (
  id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id),
  trigger_key text NOT NULL, payload jsonb NOT NULL, observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE oakridge_replacement.transition (
  id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id),
  version bigint NOT NULL CHECK (version > 0), decision jsonb NOT NULL, read_set jsonb NOT NULL,
  changes jsonb NOT NULL, causal_fact_id uuid REFERENCES oakridge_replacement.fact(id),
  local_value jsonb NOT NULL, committed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_id,version)
);
CREATE TABLE oakridge_replacement.ingress_receipt (
  scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id), ingress_id text NOT NULL,
  digest text NOT NULL, trigger jsonb NOT NULL, expected_version bigint NOT NULL CHECK (expected_version >= 0),
  decision jsonb, result jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id,ingress_id)
);
CREATE TABLE oakridge_replacement.effect_intent (
  id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id),
  transition_id uuid NOT NULL REFERENCES oakridge_replacement.transition(id),
  payload jsonb NOT NULL, delivery jsonb NOT NULL, retry_at timestamptz, acknowledged_at timestamptz
);
CREATE TABLE oakridge_replacement.capacity_pool (
  id text PRIMARY KEY, capacity integer NOT NULL CHECK (capacity >= 0),
  version bigint NOT NULL CHECK (version >= 0)
);
CREATE TABLE oakridge_replacement.capacity_reservation (
  pool_id text NOT NULL REFERENCES oakridge_replacement.capacity_pool(id),
  scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id),
  execution_id uuid REFERENCES oakridge_replacement.execution(id),
  PRIMARY KEY (pool_id,scope_id)
);
CREATE TABLE oakridge_replacement.resource_binding (
  id uuid PRIMARY KEY, scope_id uuid NOT NULL REFERENCES oakridge_replacement.scope_instance(id),
  resource_key text NOT NULL, identity jsonb NOT NULL, observation jsonb,
  version bigint NOT NULL CHECK (version >= 0), UNIQUE (scope_id,resource_key)
);
