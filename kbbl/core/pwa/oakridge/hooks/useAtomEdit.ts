import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OperatorCheckedValue, OperatorCommandDefinition, OperatorEditCommandPayload, OperatorScopeView } from "../operator-contracts";
import { submitOperatorCommand } from "../client";
import { selectDraftKey } from "../lib/operator-selectors";
import { queryKeys } from "../queryKeys";
import { randomUuid } from "../../lib/random-uuid";

interface AtomEditInput { readonly scope: OperatorScopeView; readonly command: OperatorCommandDefinition;
  readonly output_key: string; readonly collection_key: string; readonly reviewed_revision_id: string;
  readonly prev_value: OperatorCheckedValue; readonly body: OperatorCheckedValue }

export function useAtomEdit() {
  const client = useQueryClient();
  return useMutation({ mutationFn: async (input: AtomEditInput) => {
    const key = selectDraftKey(input.scope, input.command);
    if (!key) throw new Error("Target revisions are unavailable. Refresh before editing.");
    const payload: OperatorEditCommandPayload = { output_key: input.output_key, collection_key: input.collection_key,
      reviewed_revision_id: input.reviewed_revision_id, prev_value: input.prev_value, body: input.body };
    const receipt = await submitOperatorCommand({ ...key, payload, request_id: randomUuid() });
    void client.invalidateQueries({ queryKey: queryKeys.run(input.scope.run_id) });
    return receipt;
  } });
}
