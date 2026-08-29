ALTER TABLE oakridge.work_order ADD COLUMN capability_hash text;
UPDATE oakridge.work_order SET capability_hash = id::text WHERE capability_hash IS NULL;
ALTER TABLE oakridge.work_order ALTER COLUMN capability_hash SET NOT NULL;
