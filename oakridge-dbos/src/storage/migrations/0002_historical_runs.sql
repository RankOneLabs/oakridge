-- Persist the cutover decision for every run that existed before this migration.
-- Operator archiving remains independent and never authorizes execution.
ALTER TABLE authority.run ADD COLUMN historical_read_only boolean NOT NULL DEFAULT false;
UPDATE authority.run SET historical_read_only = true;
