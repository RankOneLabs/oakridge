import type { WorkerKey } from "../operator-worker-types";
import type { OperatorRequest } from "../review-command-types";
export const selectWorkerRetryRequest = (worker: WorkerKey): OperatorRequest => {
  switch (worker) {
    case "provision": return { kind: "retry_provision" };
    case "spec": return { kind: "retry_analysis" };
    case "plan": return { kind: "retry_plan" };
    case "brief": return { kind: "retry_briefs" };
    case "build": return { kind: "retry_build" };
    case "assessment": return { kind: "retry_assessment" };
    case "final_integration": return { kind: "retry_final_integration" };
  }
};
