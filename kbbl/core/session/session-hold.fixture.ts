/**
 * One recorded `SessionHold`, shared by both ends of the session-hold route
 * so a change to the field set fails both suites rather than only one.
 *
 * `oakridge-dbos/tests/production-effects.test.ts` asserts that
 * `GET /api/session_holds/:sid` returns exactly this value (wrapped in
 * `{held, hold}`); `kbbl/core/server/handlers/session-close-guard.test.ts`
 * stubs Oakridge with the same value. Importing one typed constant on both
 * sides is what makes that an enforced agreement instead of a comment
 * promising two hand-written copies stay in step.
 */
import type { SessionHold } from "./session-hold";

export const RECORDED_SESSION_HOLD: SessionHold = {
  session_id: "db26174d-21e2-40f4-af40-fc359c4e9604",
  execution_id: "012c6027-4a21-4ec4-aadd-244ebf3236a9:0",
  run_id: "9e868912-4944-4687-8316-0c2f6470bc3c",
  stage_instance_id: "012c6027-4a21-4ec4-aadd-244ebf3236a9",
  stage_key: "spec_analyzer",
  unit_id: "0",
};
