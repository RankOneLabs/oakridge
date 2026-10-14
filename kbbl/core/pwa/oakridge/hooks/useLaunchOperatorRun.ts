import { useMutation, useQueryClient } from "@tanstack/react-query";
import { launchOperatorRun } from "../client";
import { invalidateRunLists } from "../lib/operator-invalidation";

export function useLaunchOperatorRun() {
  const client = useQueryClient();
  return useMutation({ mutationFn: launchOperatorRun, onSuccess: () => invalidateRunLists(client) });
}
