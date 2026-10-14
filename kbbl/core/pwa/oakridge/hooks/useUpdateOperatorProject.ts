import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateOperatorProject } from "../client";
import type { OperatorProjectDraft } from "../operator-contracts";
import { invalidateProjects } from "../lib/operator-invalidation";

interface UpdateProjectInput { readonly projectId: string; readonly draft: OperatorProjectDraft }

export function useUpdateOperatorProject() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ projectId, draft }: UpdateProjectInput) => updateOperatorProject(projectId, draft),
    onSuccess: () => invalidateProjects(client) });
}
