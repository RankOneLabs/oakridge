import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OperatorAvailableDecision, OperatorUnitView } from "../operator-contracts";
import { submitOperatorCommand } from "../client";
import { selectDraftKey } from "../lib/operator-selectors";
import { queryKeys } from "../queryKeys";
import { randomUuid } from "../../lib/random-uuid";

/**
 * v2 has no edit command: an operator edit is a decision whose payload carries
 * the revised body, against the revision the operator actually reviewed.
 */
export interface AtomEditInput {
  readonly unit: OperatorUnitView;
  readonly decision: OperatorAvailableDecision;
  readonly reviewed_revision_id: string;
  readonly prev_body: unknown;
  readonly body: unknown;
}

export function useAtomEdit() {
  const client = useQueryClient();
  return useMutation({ mutationFn: async (input: AtomEditInput) => {
    const key = selectDraftKey(input.unit, input.decision);
    if (!key) throw new Error("Target revision is unavailable. Refresh before editing.");
    const payload = { reviewed_revision_id: input.reviewed_revision_id, prev_body: input.prev_body, body: input.body };
    const receipt = await submitOperatorCommand({ ...key, payload, request_id: randomUuid() });
    void client.invalidateQueries({ queryKey: queryKeys.run(input.unit.run_id) });
    return receipt;
  } });
}
