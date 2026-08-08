import { useMutation, useQueryClient } from "@tanstack/react-query";

import { confirmFinalPullRequest } from "../client";
import type { ConfirmFinalPullRequestRequest, RepositoryKey } from "../types";

export function useConfirmFinalPullRequest(runId: string, repositoryKey: RepositoryKey) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: ConfirmFinalPullRequestRequest) =>
      confirmFinalPullRequest(runId, repositoryKey, request),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
      void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
    },
  });
}
