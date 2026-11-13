import type { OperatorWorker } from "../operator-contracts/core-client/core-types";

export interface WorkerTrigger {
  when: string | null;
  every: string | null;
  evaluates: string | null;
  modes: ("missing" | "changes_requested" | "review_of" | "periodic")[];
  handoff: string | null;
}
export function selectWorkerTrigger(worker: OperatorWorker): WorkerTrigger {
  if (worker.kind === "code")
    return {
      when: worker.when ?? null,
      every: worker.every ?? null,
      evaluates: null,
      modes: worker.every ? ["periodic"] : ["missing"],
      handoff: null,
    };
  return {
    when: worker.when ?? null,
    every: null,
    evaluates: worker.evaluates ?? null,
    modes: [
      ...(worker.prompts.initial ? ["missing" as const] : []),
      ...(worker.prompts.review ? ["review_of" as const] : []),
      ...(worker.prompts.revise ? ["changes_requested" as const] : []),
    ],
    handoff: worker.prompts.handoff ?? null,
  };
}
