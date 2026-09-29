import { useQuery } from "@tanstack/react-query";

import { fetchRunDiagnosis } from "../client";

/** The single operator read for the whole run workspace. */
export function useRunDiagnosis(runId: string, enabled = true) {
  return useQuery({
    queryKey: ["oakridge", "run", runId, "diagnosis"],
    queryFn: () => fetchRunDiagnosis(runId),
    refetchInterval: 10_000,
    enabled,
  });
}
