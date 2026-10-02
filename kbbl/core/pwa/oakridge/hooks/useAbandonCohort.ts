import { useMutation, useQueryClient } from "@tanstack/react-query";

import { abandonCohort } from "../client";

export function useAbandonCohort(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ cohortId, detail }: { readonly cohortId: string; readonly detail: string }) =>
      abandonCohort(cohortId, detail),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
      void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
    },
  });
}
