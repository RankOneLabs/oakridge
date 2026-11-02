-- Existing revisions retain the identity pair captured under v1. New revisions
-- carry the committed definition ID without fabricating a legacy bundle.
ALTER TABLE observation.source_revision ADD COLUMN definition_id text;
ALTER TABLE observation.source_revision ADD COLUMN collection_key text;
ALTER TABLE observation.source_revision ALTER COLUMN definition_bundle_id DROP NOT NULL;
ALTER TABLE observation.source_revision ALTER COLUMN definition_bundle_digest DROP NOT NULL;
ALTER TABLE observation.source_revision ADD CONSTRAINT source_revision_definition_identity CHECK (
  (definition_id IS NOT NULL AND definition_bundle_id IS NULL AND definition_bundle_digest IS NULL)
  OR (definition_id IS NULL AND definition_bundle_id IS NOT NULL AND definition_bundle_digest IS NOT NULL)
);
