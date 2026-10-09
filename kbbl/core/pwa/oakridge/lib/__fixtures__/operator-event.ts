import type { OperatorRunEvent } from "../../operator-contracts";

/** A committed transition as GET /events delivers it. */
export const operatorEvent = (overrides: Partial<OperatorRunEvent> = {}): OperatorRunEvent => ({
  transition_id: "transition-1", run_id: "run-one", scope_id: "scope-one", scope_key: "spec_analysis", decision: "wait",
  attention: { label: "Awaiting work or review", trigger: "accept" }, is_terminal: false, occurred_at: "2026-10-09T00:00:00.000Z",
  ...overrides,
});
