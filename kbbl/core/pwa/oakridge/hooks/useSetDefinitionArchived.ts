import { useMutation, useQueryClient } from "@tanstack/react-query";
import { setOperatorDefinitionArchived } from "../client";
import { invalidateDefinitions } from "../lib/operator-invalidation";

interface ArchiveDefinitionInput { readonly bundleId: string; readonly isArchived: boolean }

export function useSetDefinitionArchived() {
  const client = useQueryClient();
  return useMutation({ mutationFn: ({ bundleId, isArchived }: ArchiveDefinitionInput) => setOperatorDefinitionArchived(bundleId, isArchived),
    onSuccess: () => invalidateDefinitions(client) });
}
