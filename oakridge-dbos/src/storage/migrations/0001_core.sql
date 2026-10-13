-- Oakridge v2 authority baseline. Apply only to an empty PostgreSQL 15+ database.
CREATE SCHEMA authority;

CREATE TYPE authority.effect_status AS ENUM
  ('pending', 'acknowledged', 'stop_requested', 'stopped', 'failed');

CREATE TABLE authority.schema_baseline (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE authority.definition_bundle (
  id text PRIMARY KEY,
  digest text NOT NULL UNIQUE,
  source jsonb NOT NULL,
  checked_program jsonb NOT NULL,
  -- prompt path -> content digest, pinned at compile (D9). Editing a prompt
  -- file afterwards cannot change what this definition renders.
  prompts jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE authority.project (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  repo_dir text NOT NULL,
  forge_repository jsonb,
  integration_branch text,
  session_policy jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE authority.prompt_content (
  content_digest text PRIMARY KEY,
  content text NOT NULL,
  CHECK (content_digest = encode(sha256(convert_to(content, 'UTF8')), 'hex'))
);

CREATE TABLE authority.run (
  id text PRIMARY KEY,
  definition_bundle_id text NOT NULL REFERENCES authority.definition_bundle(id),
  project_id text REFERENCES authority.project(id),
  root_unit_id text,
  input jsonb,
  status jsonb NOT NULL DEFAULT '{"kind":"not_started"}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  archived_at timestamptz
);

CREATE TABLE authority.unit (
  id text NOT NULL,
  run_id text NOT NULL REFERENCES authority.run(id),
  parent_id text,
  unit_key text NOT NULL,
  collection_key text,
  declaration text NOT NULL,
  stage text,
  pool text,
  input jsonb NOT NULL,
  status jsonb NOT NULL,
  -- Each operator review awaiting a decision, by review key: the revision it
  -- decides on and its prompt rendered with its resolved inputs. Commit
  -- rewrites it on every event that steps the unit; nothing is asked or stored
  -- beyond what state already derives.
  review_prompts jsonb NOT NULL DEFAULT '{}'::jsonb,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  PRIMARY KEY (run_id, id),
  -- run_id is load-bearing: roots in different runs both have a NULL parent
  -- and the same unit key. Omitting it makes the second launch collide.
  UNIQUE NULLS NOT DISTINCT (run_id, parent_id, unit_key, collection_key),
  FOREIGN KEY (run_id, parent_id) REFERENCES authority.unit(run_id, id)
);
ALTER TABLE authority.run ADD CONSTRAINT run_root_unit_fk
  FOREIGN KEY (id, root_unit_id) REFERENCES authority.unit(run_id, id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE authority.unit_dependency (
  run_id text NOT NULL,
  unit_id text NOT NULL,
  depends_on_id text NOT NULL,
  PRIMARY KEY (run_id, unit_id, depends_on_id),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id),
  FOREIGN KEY (run_id, depends_on_id) REFERENCES authority.unit(run_id, id),
  CHECK (unit_id <> depends_on_id)
);

CREATE TABLE authority.attempt (
  action_id text NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0),
  run_id text NOT NULL,
  unit_id text NOT NULL,
  worker text NOT NULL,
  mode jsonb NOT NULL,
  cause jsonb NOT NULL,
  status jsonb NOT NULL,
  ended_at bigint,
  kbbl_session_id text,
  publication_secret_hash text CHECK (publication_secret_hash IS NULL OR publication_secret_hash ~ '^[0-9a-f]{64}$'),
  -- When commit opened the attempt, stamped after it took the run row lock
  -- (clock_timestamp, not the transaction's start), so it orders after every
  -- revision committed before it: a task renders only revisions written by
  -- then, and a re-rendered task is the same text.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (action_id, seq),
  UNIQUE (run_id, action_id, seq),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id)
);

CREATE TABLE authority.artifact_revision (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  artifact text NOT NULL,
  body jsonb NOT NULL,
  by_id text NOT NULL,
  predecessor_id text,
  subject text,
  -- Stamped at insert, under the run row lock, so revisions and attempts of a
  -- run order by when commit wrote them (see attempt.created_at).
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, id),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id),
  FOREIGN KEY (run_id, predecessor_id) REFERENCES authority.artifact_revision(run_id, id)
);

CREATE TABLE authority.review_decision (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  review text NOT NULL,
  decision text NOT NULL,
  effect text NOT NULL CHECK (effect IN ('approve', 'request_changes')),
  target_revision_id text NOT NULL,
  payload jsonb NOT NULL,
  -- The order commit wrote it, stamped under the run row lock. The core reads
  -- a unit's decisions in this order; the id (`<unit>:d<n>`) does not sort.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id),
  FOREIGN KEY (run_id, target_revision_id) REFERENCES authority.artifact_revision(run_id, id)
);

CREATE TABLE authority.event (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES authority.run(id),
  unit_id text,
  ingress_id text,
  payload jsonb NOT NULL,
  writer jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  commit_txid bigint NOT NULL DEFAULT pg_current_xact_id()::text::bigint,
  UNIQUE (run_id, id),
  UNIQUE (run_id, ingress_id),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id)
);

CREATE TABLE authority.wanted_log (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  event_id text NOT NULL,
  actions jsonb NOT NULL CHECK (jsonb_typeof(actions) = 'array'),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id),
  FOREIGN KEY (run_id, event_id) REFERENCES authority.event(run_id, id)
);

CREATE TABLE authority.effect_intent (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  action_id text NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0),
  payload jsonb NOT NULL,
  status authority.effect_status NOT NULL DEFAULT 'pending',
  -- Executor bookkeeping: provider start attempts claimed, when the next may
  -- run, and why the last one did not succeed.
  tries integer NOT NULL DEFAULT 0 CHECK (tries >= 0),
  next_try_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (action_id, seq),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id)
);

CREATE TABLE authority.ingress_receipt (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES authority.run(id),
  unit_id text,
  ingress_id text NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  UNIQUE (run_id, ingress_id),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id)
);

-- The collaboration records remain tied to a run and its unit. Revision
-- references use (run_id, id) so a row cannot attach evidence from another run.
CREATE TABLE authority.collaboration_thread (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  artifact_revision_id text,
  context jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, id),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id),
  FOREIGN KEY (run_id, artifact_revision_id) REFERENCES authority.artifact_revision(run_id, id)
);
CREATE TABLE authority.collaboration_message (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  thread_id text NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, id),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id),
  FOREIGN KEY (run_id, thread_id) REFERENCES authority.collaboration_thread(run_id, id)
);
CREATE TABLE authority.review_item (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  artifact_revision_id text,
  thread_id text,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id),
  FOREIGN KEY (run_id, artifact_revision_id) REFERENCES authority.artifact_revision(run_id, id),
  FOREIGN KEY (run_id, thread_id) REFERENCES authority.collaboration_thread(run_id, id)
);
CREATE TABLE authority.collaboration_delivery (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  unit_id text NOT NULL,
  message_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (run_id, unit_id) REFERENCES authority.unit(run_id, id),
  FOREIGN KEY (run_id, message_id) REFERENCES authority.collaboration_message(run_id, id)
);

-- The operator stream's outbox. Written by commit and the registry store in the
-- transaction that causes it; never read by step. A deleted run leaves its
-- rows in the stream with no run (D12).
CREATE TABLE authority.operator_event (
  id text PRIMARY KEY,
  run_id text REFERENCES authority.run(id) ON DELETE SET NULL,
  -- The key of the entity the event concerns (run, definition or project id);
  -- kept when the run is deleted.
  run_key text NOT NULL,
  event_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  commit_txid bigint NOT NULL DEFAULT pg_current_xact_id()::text::bigint
);

-- unit is keyed (run_id, id) and its parent lookups use the (run_id, parent_id, …)
-- unique index; the rest serve commit, the executor and the read store per unit.
CREATE INDEX attempt_unit_idx ON authority.attempt(run_id, unit_id);
CREATE INDEX artifact_revision_unit_idx ON authority.artifact_revision(run_id, unit_id, artifact, created_at);
CREATE INDEX review_decision_unit_idx ON authority.review_decision(run_id, unit_id);
CREATE INDEX event_commit_idx ON authority.event(commit_txid, id);
CREATE INDEX event_run_created_idx ON authority.event(run_id, created_at, id);
CREATE INDEX event_unit_created_idx ON authority.event(run_id, unit_id, created_at, id);
CREATE INDEX wanted_log_unit_idx ON authority.wanted_log(run_id, unit_id);
CREATE INDEX effect_intent_run_idx ON authority.effect_intent(run_id, status);
CREATE INDEX effect_intent_unit_idx ON authority.effect_intent(run_id, unit_id);
CREATE INDEX operator_event_commit_idx ON authority.operator_event(commit_txid, id);

COMMENT ON COLUMN authority.definition_bundle.source IS '@type {DefinitionBundleSource}';
COMMENT ON COLUMN authority.definition_bundle.checked_program IS '@type {CompiledWorkflow}';
COMMENT ON COLUMN authority.definition_bundle.prompts IS '@type {PinnedPrompts}';
COMMENT ON COLUMN authority.project.forge_repository IS '@type {ForgeRepository}';
COMMENT ON COLUMN authority.project.session_policy IS '@type {SessionPolicy}';
COMMENT ON COLUMN authority.run.input IS '@type {RuntimeValue}';
COMMENT ON COLUMN authority.run.status IS '@type {UnitStatus}';
COMMENT ON COLUMN authority.unit.input IS '@type {RuntimeValue}';
COMMENT ON COLUMN authority.unit.status IS '@type {UnitStatus}';
COMMENT ON COLUMN authority.unit.review_prompts IS '@type {ReviewPrompts}';
COMMENT ON COLUMN authority.attempt.mode IS '@type {Mode}';
COMMENT ON COLUMN authority.attempt.cause IS '@type {Cause}';
COMMENT ON COLUMN authority.attempt.status IS '@type {AttemptStatus}';
COMMENT ON COLUMN authority.artifact_revision.body IS '@type {RuntimeValue}';
COMMENT ON COLUMN authority.review_decision.payload IS '@type {RuntimeValue}';
COMMENT ON COLUMN authority.event.payload IS '@type {CoreEvent}';
COMMENT ON COLUMN authority.event.writer IS '@type {Writer}';
COMMENT ON COLUMN authority.wanted_log.actions IS '@type {WantedActions}';
COMMENT ON COLUMN authority.effect_intent.payload IS '@type {EffectInstruction}';
COMMENT ON COLUMN authority.ingress_receipt.result IS '@type {CommitReceipt}';
COMMENT ON COLUMN authority.collaboration_thread.context IS '@type {CollaborationThreadContext}';
COMMENT ON COLUMN authority.collaboration_message.body IS '@type {CollaborationMessageBody}';
COMMENT ON COLUMN authority.review_item.body IS '@type {ReviewItemBody}';
COMMENT ON COLUMN authority.collaboration_delivery.payload IS '@type {CollaborationDeliveryPayload}';
COMMENT ON COLUMN authority.operator_event.payload IS '@type {OperatorEventPayload}';
