-- Store the emitting stage's output slot name alongside the artifact so crash
-- recovery can route artifacts to downstream consumers without ambiguity when a
-- stage has multiple outputs of the same artifact_type.
ALTER TABLE artifact ADD COLUMN output_name TEXT;
