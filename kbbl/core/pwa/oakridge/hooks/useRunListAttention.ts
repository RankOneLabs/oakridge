import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchOperatorRunInboxes } from "../client";
import type { OperatorInboxPage } from "../operator-contracts";
import { queryKeys } from "../queryKeys";

export function useRunListAttention(runIds: readonly string[], isArchived: boolean, enabled: boolean) {
  const client = useQueryClient();
  return useQuery({
    queryKey: queryKeys.runListAttention(isArchived, runIds),
    queryFn: async () => {
      const batch = await fetchOperatorRunInboxes(runIds);
      for (const entry of batch.items)
        client.setQueryData(queryKeys.runAttention(entry.run_id), { items: entry.items, next_cursor: null } satisfies OperatorInboxPage);
      return batch;
    },
    enabled: enabled && runIds.length > 0,
  });
}
