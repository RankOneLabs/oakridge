import { useMutation, useQueryClient } from "@tanstack/react-query";
import { setOperatorRunArchived } from "../client";
import { invalidateRunLists } from "../lib/operator-invalidation";

interface ArchiveInput { readonly runId: string; readonly isArchived: boolean }

export function useSetRunArchived() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ runId, isArchived }: ArchiveInput) => setOperatorRunArchived(runId, isArchived),
    onSuccess: () => invalidateRunLists(client) });
}
