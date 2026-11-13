import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readGradingConfiguration, type GradingConfigurationRead } from "../client-grading-config";
import type { GradingFeedback } from "../lib/grading-config";
interface GradingConfigurationSnapshot { readonly read: GradingConfigurationRead; readonly revision: number }
export const GRADING_CONFIG_QUERY_KEY = ["oakridge", "grading-config"] as const;
/** Marks every cached read stale after a write; mounted editors keep their local edits. */
export function useGradingConfigurationWrites() {
  const client = useQueryClient();
  return { recordWrite: () => void client.invalidateQueries({ queryKey: GRADING_CONFIG_QUERY_KEY, refetchType: "none" }) };
}
export function useGradingConfiguration(version: number | null) {
  // The draft is shared, so an editor is seeded only from a read made after it mounted, never from cache.
  const query = useQuery({ queryKey: [...GRADING_CONFIG_QUERY_KEY, version], queryFn: () => readGradingConfiguration(version), refetchOnMount: "always", refetchOnWindowFocus: false, refetchOnReconnect: false });
  const [snapshot, setSnapshot] = useState<GradingConfigurationSnapshot | null>(null);
  const [reloadFeedback, setReloadFeedback] = useState<GradingFeedback | null>(null);
  useEffect(() => {
    const result = query.data;
    if (result?.ok && query.isFetchedAfterMount) setSnapshot((current) => current ?? { read: result.value, revision: 0 });
  }, [query.data, query.isFetchedAfterMount]);
  const reload = async () => {
    setReloadFeedback(null);
    const result = await query.refetch();
    if (result.data?.ok && !result.isError) {
      const read = result.data.value;
      setSnapshot((current) => ({ read, revision: (current?.revision ?? 0) + 1 }));
    } else setReloadFeedback(result.data?.ok === false ? result.data.feedback : { kind: "transport_error", detail: result.error?.message ?? "Reload failed" });
  };
  return { ...query, snapshot, reload, reloadFeedback };
}
