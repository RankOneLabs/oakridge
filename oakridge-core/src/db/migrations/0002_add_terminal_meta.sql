-- Add terminal metadata to stage instances.

ALTER TABLE stage_instance ADD COLUMN terminal_meta TEXT;
