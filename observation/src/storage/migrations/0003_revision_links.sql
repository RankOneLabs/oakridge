-- Preserve producer revision links without changing captured bodies or the L0 baseline digest.
ALTER TABLE observation.source_revision
  ADD COLUMN predecessor_id text,
  ADD COLUMN subject_id text,
  ADD CONSTRAINT source_revision_predecessor_nonempty CHECK (predecessor_id IS NULL OR predecessor_id <> ''),
  ADD CONSTRAINT source_revision_subject_nonempty CHECK (subject_id IS NULL OR subject_id <> '');
