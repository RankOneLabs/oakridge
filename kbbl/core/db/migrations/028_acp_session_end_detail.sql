-- Persist why a session ended alongside the code that names it.
--
-- `end_reason` holds an `AcpFailureCode` for a failed session, which is what
-- a caller branches on. The AcpError that killed provisioning also carries a
-- `detail` — the agent's own message, the spawn errno, the model id that was
-- not advertised — and that was written only to the server log, so the
-- terminal route's `failure.detail` could do no better than echo the code
-- back. Mirrors the failure_code / failure_detail pair acp_turns already has.

ALTER TABLE acp_sessions ADD COLUMN end_detail TEXT;
