-- Compare both transaction ids in the 32-bit xid domain used by xmin. xid8
-- retains the epoch, so a direct text comparison fails after the first wrap.
CREATE OR REPLACE FUNCTION observation.require_new_export_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM observation.export_manifest m
    WHERE m.producer = NEW.producer AND m.namespace = NEW.namespace AND m.manifest_id = NEW.manifest_id
      AND m.xmin::text::bigint = mod(pg_current_xact_id()::text::numeric, 4294967296)::bigint) THEN
    RAISE EXCEPTION 'export membership can only be written with its new manifest';
  END IF;
  RETURN NEW;
END $$;
