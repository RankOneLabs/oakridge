import { useMutation, useQueryClient } from "@tanstack/react-query";
import { pinOperatorDefinition } from "../client";
import type { WorkflowDefinitionDescriptor } from "../workflow-definition-types";
import { invalidateDefinitions } from "../lib/operator-invalidation";

export function usePinOperatorDefinition() {
  const client = useQueryClient();
  return useMutation({ mutationFn: (workflow: WorkflowDefinitionDescriptor) => pinOperatorDefinition(workflow),
    onSuccess: () => invalidateDefinitions(client) });
}
