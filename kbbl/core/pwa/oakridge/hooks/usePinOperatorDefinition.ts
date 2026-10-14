import { useMutation, useQueryClient } from "@tanstack/react-query";
import { pinOperatorDefinition } from "../client";
import type { OperatorWorkflow } from "../operator-contracts";
import { invalidateDefinitions } from "../lib/operator-invalidation";

export function usePinOperatorDefinition() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (workflow: OperatorWorkflow) => pinOperatorDefinition(workflow),
    onSuccess: () => invalidateDefinitions(client) });
}
