-- Artifact-anchored review discussion, and the retry key an attempt is claimed
-- under.
--
-- Additive, as 0016 established. `migrate.ts` keys applied migrations by file
-- name with no checksum, so editing the 0015 baseline would silently skip on
-- every database that already applied it.

-- The v15 baseline kept `session_message.artifact_thread_id` but shipped no
-- table for it to reference. Session messaging is *delivery* — sender,
-- recipient, delivery key, status machine, one DBOS workflow per message — and
-- a thread is operator/agent discussion anchored on one artifact revision,
-- keyed on (chain, anchor) and resolvable. Neither subsumes the other, so the
-- column gets its referent and its foreign key here.
CREATE TABLE oakridge.artifact_thread (
  id uuid PRIMARY KEY,
  -- The revision chain the discussion belongs to: a thread survives the
  -- revision it was opened on.
  chain_id uuid NOT NULL,
  -- The exact revision it was opened against.
  artifact_id uuid NOT NULL REFERENCES oakridge.artifact(id) ON DELETE CASCADE,
  anchor text CHECK (anchor IS NULL OR length(btrim(anchor)) > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifact_thread_chain_idx ON oakridge.artifact_thread (chain_id, created_at, id);
CREATE INDEX artifact_thread_revision_idx ON oakridge.artifact_thread (artifact_id);

CREATE TABLE oakridge.artifact_thread_message (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES oakridge.artifact_thread(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  author text NOT NULL CHECK (length(btrim(author)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifact_thread_message_thread_idx
  ON oakridge.artifact_thread_message (thread_id, created_at, id);

ALTER TABLE oakridge.session_message
  ADD CONSTRAINT session_message_artifact_thread_fk
  FOREIGN KEY (artifact_thread_id) REFERENCES oakridge.artifact_thread(id);

-- An operator retry is addressed by an `Idempotency-Key` the caller chose, and
-- the PWA sends one precisely so a re-submit after a *completed* retry returns
-- the attempt it already created rather than opening a second one.
-- `run_transition.effect_workflow_id UNIQUE` only dedupes concurrent calls at
-- the same prior owner version, which is the sequential case it cannot see.
ALTER TABLE oakridge.attempt
  ADD COLUMN idempotency_key text
    CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) > 0),
  ADD CONSTRAINT attempt_cohort_idempotency_key_unique UNIQUE (cohort_id, idempotency_key);
