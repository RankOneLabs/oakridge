import { expect, test } from "bun:test";
import { selectClaimAnswer, type ExecutionState, type KeyedExecutionRecovery } from "../src/domain/keyed-execution";

const evidence = { external_id: "external", store_path: "/runs/result", detail: "Accepted" };
const states = ["unclaimed", "claimed", "evidence_attached", "reconcile"] as const satisfies readonly ExecutionState[];
for (const recovery of ["off", "by_key"] as const satisfies readonly KeyedExecutionRecovery[]) {
  for (const state of states) test(`claim transition from ${state} with recovery ${recovery}`, () => {
    const expected: Record<ExecutionState, ReturnType<typeof selectClaimAnswer>> = {
      unclaimed: { answer: { kind: "launch" }, next_state: "claimed" },
      claimed: recovery === "by_key" ? { answer: { kind: "recover" }, next_state: "claimed" }
        : { answer: { kind: "reconcile_required" }, next_state: "reconcile" },
      evidence_attached: { answer: { kind: "resume", evidence }, next_state: "evidence_attached" },
      reconcile: { answer: { kind: "reconcile_required" }, next_state: "reconcile" },
    } as const;
    expect(selectClaimAnswer({ state, evidence: state === "evidence_attached" ? evidence : null }, recovery)).toEqual(expected[state]);
  });
}
