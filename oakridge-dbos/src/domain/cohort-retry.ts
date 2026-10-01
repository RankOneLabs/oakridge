import type { CohortMachineState } from "./run-record";

export type CohortRetryability = { readonly kind: "retryable" }
  | { readonly kind: "not_retryable";
    readonly reason: "terminal" | "gate_pending" | "work_in_progress" | "not_lost" };

export const selectCohortRetryability = (
  cohort: Pick<CohortMachineState, "status" | "blocked_reason" | "next_actor">,
): CohortRetryability => {
  if (cohort.status === "complete" || cohort.status === "failed" || cohort.status === "cancelled") {
    return { kind: "not_retryable", reason: "terminal" };
  }
  if (cohort.status === "blocked" && cohort.blocked_reason === "retry" && cohort.next_actor === "operator") {
    return { kind: "retryable" };
  }
  if (cohort.blocked_reason === "gate") return { kind: "not_retryable", reason: "gate_pending" };
  if (cohort.status === "active") return { kind: "not_retryable", reason: "work_in_progress" };
  return { kind: "not_retryable", reason: "not_lost" };
};
