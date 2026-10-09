-- Oakridge authority baseline. Apply only to a new database.
CREATE SCHEMA authority;

CREATE TYPE authority.execution_status AS ENUM ('pending', 'terminal');
CREATE TYPE authority.effect_status AS ENUM ('pending', 'acknowledged', 'rejected', 'revoked', 'cleanup_pending', 'cleanup_confirmed');

CREATE TABLE authority.schema_baseline (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Resolve a child's run from its scope before its composite foreign key is checked.
CREATE FUNCTION authority.inherit_scope_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_id IS NULL THEN
    SELECT run_id INTO NEW.run_id FROM authority.scope_instance WHERE id = NEW.scope_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE authority.definition_bundle (
  id text PRIMARY KEY, digest text NOT NULL UNIQUE, source jsonb NOT NULL,
  checked_program jsonb NOT NULL, version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), authoring jsonb,
  -- Operator visibility only: an archived definition is hidden from listings and still runs.
  archived_at timestamptz
);
-- Saved repositories own the editable session policy. A run retains its project
-- link while invocations pin the settings resolved at their selection time.
CREATE TABLE authority.project (
  id text PRIMARY KEY, name text NOT NULL UNIQUE, repo_dir text NOT NULL,
  forge_repository jsonb, integration_branch text, session_policy jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Prompt text a pinned definition references by digest; immutable and content-addressed.
CREATE TABLE authority.prompt_content (
  content_digest text PRIMARY KEY, content text NOT NULL,
  CHECK (content_digest = encode(sha256(convert_to(content, 'UTF8')), 'hex'))
);
CREATE TABLE authority.run (
  id text PRIMARY KEY, definition_bundle_id text NOT NULL REFERENCES authority.definition_bundle(id),
  project_id text REFERENCES authority.project(id),
  created_at timestamptz NOT NULL DEFAULT now(), version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  current_generation bigint NOT NULL DEFAULT 0 CHECK (current_generation >= 0),
  current_cursor text,
  -- Operator visibility only: an archived run is hidden from listings; its scopes are untouched.
  archived_at timestamptz
);
CREATE TABLE authority.scope_instance (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES authority.run(id),
  parent_id text, scope_key text NOT NULL,
  child_key text, collection_key text, input jsonb NOT NULL, local_state jsonb NOT NULL,
  outcome jsonb, is_terminal boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (run_id, id),
  FOREIGN KEY (run_id, parent_id) REFERENCES authority.scope_instance(run_id, id)
);
-- Launch identities survive run deletion, preventing a late retry from recreating work.
CREATE TABLE authority.launch_receipt (
  request_id text PRIMARY KEY CHECK (length(request_id) BETWEEN 1 AND 200),
  request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  run_id text REFERENCES authority.run(id) ON DELETE SET NULL,
  root_scope_id text NOT NULL, bundle_id text NOT NULL REFERENCES authority.definition_bundle(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scope_instance_child_identity_idx ON authority.scope_instance
  (parent_id, collection_key, child_key) NULLS NOT DISTINCT WHERE parent_id IS NOT NULL;
CREATE TABLE authority.scope_export (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  export_key text NOT NULL, value jsonb NOT NULL, version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (scope_id, export_key), FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id)
);
CREATE TABLE authority.child_collection (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  collection_key text NOT NULL, members jsonb NOT NULL DEFAULT '[]'::jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (scope_id, collection_key),
  CHECK (jsonb_typeof(members) = 'array'), FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id)
);
CREATE TABLE authority.execution_selection (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  worker_key text NOT NULL, execution_id text, generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (scope_id, worker_key),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id)
);
CREATE TABLE authority.execution (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  worker_key text NOT NULL, generation bigint NOT NULL CHECK (generation >= 0),
  status authority.execution_status NOT NULL, result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  publication_secret_hash text CHECK (publication_secret_hash IS NULL OR publication_secret_hash ~ '^[0-9a-f]{64}$'),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (scope_id, worker_key, generation), UNIQUE (run_id, id),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id)
);
ALTER TABLE authority.execution_selection ADD CONSTRAINT execution_selection_execution_fk
  FOREIGN KEY (run_id, execution_id) REFERENCES authority.execution(run_id, id);
CREATE TABLE authority.artifact_revision (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  execution_id text, output_key text NOT NULL,
  collection_key text NOT NULL DEFAULT '', body jsonb NOT NULL, predecessor_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (run_id, id),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id),
  FOREIGN KEY (run_id, execution_id) REFERENCES authority.execution(run_id, id),
  FOREIGN KEY (run_id, predecessor_id) REFERENCES authority.artifact_revision(run_id, id)
);
CREATE TABLE authority.output_slot (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  output_key text NOT NULL, collection_key text NOT NULL DEFAULT '',
  current_revision_id text,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (scope_id, output_key, collection_key),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id),
  FOREIGN KEY (run_id, current_revision_id) REFERENCES authority.artifact_revision(run_id, id)
);
CREATE TABLE authority.fact (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  fact_key text NOT NULL, payload jsonb NOT NULL,
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id)
);
CREATE TABLE authority.transition (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  trigger_id text NOT NULL, decision jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The writing transaction; the event stream reads only transactions older than every one still open, so it never skips a late commit.
  commit_txid bigint NOT NULL DEFAULT pg_current_xact_id()::text::bigint,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  -- One recorded transition per delivered ingress; ingress_receipt also enforces idempotency.
  UNIQUE (scope_id, trigger_id),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id)
);
CREATE TABLE authority.ingress_receipt (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES authority.run(id),
  scope_id text NOT NULL,
  ingress_id text NOT NULL, request_digest text NOT NULL,
  result jsonb NOT NULL,
  UNIQUE (run_id, scope_id, ingress_id),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id)
);
CREATE TABLE authority.effect_intent (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  execution_id text, effect_key text NOT NULL,
  payload jsonb NOT NULL, status authority.effect_status NOT NULL DEFAULT 'pending',
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (scope_id, effect_key),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id),
  FOREIGN KEY (run_id, execution_id) REFERENCES authority.execution(run_id, id)
);
CREATE TABLE authority.capacity_pool (
  id text PRIMARY KEY, run_id text NOT NULL REFERENCES authority.run(id),
  pool_key text NOT NULL, capacity integer NOT NULL CHECK (capacity >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (run_id, pool_key), UNIQUE (run_id, id)
);
CREATE TABLE authority.capacity_reservation (
  id text PRIMARY KEY, run_id text NOT NULL, pool_id text NOT NULL,
  scope_id text NOT NULL,
  is_active boolean NOT NULL DEFAULT true, version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (pool_id, scope_id),
  FOREIGN KEY (run_id, pool_id) REFERENCES authority.capacity_pool(run_id, id),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id)
);
CREATE TABLE authority.resource_binding (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  resource_key text NOT NULL, observation jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0), UNIQUE (scope_id, resource_key),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id)
);
-- Outbox rows retain their run identity as text after run deletion. The nullable
-- FK is cleared, leaving a durable event for consumers already behind the cursor.
CREATE TABLE authority.operator_event (
  id text PRIMARY KEY, run_id text REFERENCES authority.run(id) ON DELETE SET NULL,
  run_key text NOT NULL, event_key text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  commit_txid bigint NOT NULL DEFAULT pg_current_xact_id()::text::bigint
);
CREATE INDEX operator_event_commit_idx ON authority.operator_event(commit_txid, id);

CREATE TABLE authority.collaboration_thread (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  artifact_revision_id text, context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, id),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id),
  FOREIGN KEY (run_id, artifact_revision_id) REFERENCES authority.artifact_revision(run_id, id)
);
CREATE TABLE authority.collaboration_message (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  thread_id text NOT NULL, body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, id),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id),
  FOREIGN KEY (run_id, thread_id) REFERENCES authority.collaboration_thread(run_id, id)
);
CREATE TABLE authority.review_item (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  artifact_revision_id text, thread_id text, body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id),
  FOREIGN KEY (run_id, artifact_revision_id) REFERENCES authority.artifact_revision(run_id, id),
  FOREIGN KEY (run_id, thread_id) REFERENCES authority.collaboration_thread(run_id, id)
);
CREATE TABLE authority.collaboration_delivery (
  id text PRIMARY KEY, run_id text NOT NULL, scope_id text NOT NULL,
  message_id text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, scope_id) REFERENCES authority.scope_instance(run_id, id),
  FOREIGN KEY (run_id, message_id) REFERENCES authority.collaboration_message(run_id, id)
);
DO $$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY['scope_export', 'child_collection', 'execution_selection',
    'execution', 'artifact_revision', 'output_slot', 'fact', 'transition', 'ingress_receipt',
    'effect_intent', 'capacity_reservation', 'resource_binding'] LOOP
    EXECUTE format('CREATE TRIGGER inherit_scope_run BEFORE INSERT ON authority.%I FOR EACH ROW EXECUTE FUNCTION authority.inherit_scope_run()', relation_name);
  END LOOP;
END;
$$;
CREATE INDEX scope_instance_run_idx ON authority.scope_instance(run_id);
CREATE INDEX scope_instance_parent_idx ON authority.scope_instance(parent_id);
CREATE INDEX reservation_active_idx ON authority.capacity_reservation(pool_id) WHERE is_active;
CREATE INDEX transition_scope_created_idx ON authority.transition(scope_id, created_at DESC);
CREATE INDEX fact_scope_key_idx ON authority.fact(scope_id, fact_key);
CREATE INDEX artifact_revision_scope_idx ON authority.artifact_revision(scope_id);
CREATE INDEX effect_intent_status_idx ON authority.effect_intent(status);
CREATE INDEX effect_intent_session_id_idx ON authority.effect_intent ((payload->'handle'->>'session_id'));
CREATE INDEX fact_scope_idx ON authority.fact(scope_id);
CREATE INDEX transition_scope_idx ON authority.transition(scope_id);
CREATE INDEX transition_commit_idx ON authority.transition(commit_txid, id);
CREATE INDEX execution_selection_execution_idx ON authority.execution_selection(execution_id);

-- JSON column types for the generated storage records (scripts/generate-storage-records.ts).
-- Each @type names an export of src/storage/json-column-types.ts.
COMMENT ON COLUMN authority.definition_bundle.source IS '@type {DefinitionBundleSource}';
COMMENT ON COLUMN authority.definition_bundle.checked_program IS '@type {CompiledBundle}';
COMMENT ON COLUMN authority.definition_bundle.authoring IS '@type {WorkflowAuthoring}';
COMMENT ON COLUMN authority.scope_instance.input IS '@type {CheckedValue}';
COMMENT ON COLUMN authority.scope_instance.local_state IS '@type {CheckedValue}';
COMMENT ON COLUMN authority.scope_instance.outcome IS '@type {CheckedValue}';
COMMENT ON COLUMN authority.scope_export.value IS '@type {CheckedValue}';
COMMENT ON COLUMN authority.child_collection.members IS '@type {ChildCollectionMembers}';
COMMENT ON COLUMN authority.execution.result IS '@type {CheckedValue}';
COMMENT ON COLUMN authority.artifact_revision.body IS '@type {CheckedValue}';
COMMENT ON COLUMN authority.fact.payload IS '@type {CheckedValue}';
COMMENT ON COLUMN authority.transition.decision IS '@type {DecisionOutcome}';
COMMENT ON COLUMN authority.ingress_receipt.result IS '@type {CommitReceipt}';
COMMENT ON COLUMN authority.effect_intent.payload IS '@type {EffectIntentPayload}';
COMMENT ON COLUMN authority.operator_event.payload IS '@type {OperatorEventPayload}';
COMMENT ON COLUMN authority.collaboration_thread.context IS '@type {CollaborationThreadContext}';
COMMENT ON COLUMN authority.collaboration_message.body IS '@type {CollaborationMessageBody}';
COMMENT ON COLUMN authority.review_item.body IS '@type {ReviewItemBody}';
COMMENT ON COLUMN authority.collaboration_delivery.payload IS '@type {CollaborationDeliveryPayload}';
COMMENT ON COLUMN authority.resource_binding.observation IS '@type {CheckedValue}';
COMMENT ON COLUMN authority.project.forge_repository IS '@type {ForgeRepository}';
COMMENT ON COLUMN authority.project.session_policy IS '@type {SessionPolicy}';
