import { useQuery } from "@tanstack/react-query";
import { fetchOperatorRunInbox } from "../client";
import { queryKeys } from "../queryKeys";

export function useRunAttention(runId: string) {
  return useQuery({ queryKey: queryKeys.runAttention(runId), queryFn: () => fetchOperatorRunInbox(runId), staleTime: 30_000 });
}
