import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createOperatorProject } from "../client";
import { invalidateProjects } from "../lib/operator-invalidation";

export function useCreateOperatorProject() {
  const client = useQueryClient();
  return useMutation({ mutationFn: createOperatorProject, onSuccess: () => invalidateProjects(client) });
}
