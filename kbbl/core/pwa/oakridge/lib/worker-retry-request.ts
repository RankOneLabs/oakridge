import type { V15OperatorRequest, V15WorkerKey } from "../../../../../oakridge-dbos/src/domain/dev-flow-v15";
export const selectWorkerRetryRequest = (worker: V15WorkerKey): V15OperatorRequest => {
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
