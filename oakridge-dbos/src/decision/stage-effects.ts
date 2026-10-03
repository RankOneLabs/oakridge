/** Pure selected changes. IO dispatch lives in runtime/run-launch-dispatch.ts. */
import type { CohortChange, SelectedDecision } from "../domain/dev-flow-v15";

export const selectedCohortState = (decision: Extract<SelectedDecision, { readonly kind: "apply" }>):
  Extract<CohortChange, { readonly kind: "set_cohort_state" }>["state"] | null =>
  decision.changes.find((change) => change.kind === "set_cohort_state")?.state ?? null;
