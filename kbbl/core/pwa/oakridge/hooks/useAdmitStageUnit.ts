import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OperatorCommandDefinition, OperatorScopeView } from "../operator-contracts";
import { submitOperatorCommand } from "../client";
import { selectDraftKey } from "../lib/operator-selectors";
import { queryKeys } from "../queryKeys";
import { randomUuid } from "../../lib/random-uuid";

interface AdmitInput { readonly scope: OperatorScopeView; readonly command: OperatorCommandDefinition }
export function useAdmitStageUnit() {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ scope, command }: AdmitInput) => {
    const key = selectDraftKey(scope, command);
    if (!key) throw new Error("Admission targets are unavailable. Refresh this scope.");
    const receipt = await submitOperatorCommand({ ...key, payload: {}, request_id: randomUuid() });
    void client.invalidateQueries({ queryKey: queryKeys.run(scope.run_id) });
    return receipt;
  } });
}
