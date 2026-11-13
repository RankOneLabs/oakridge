import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { readGradingConfiguration, type GradingConfigurationRead } from "../client-grading-config";
import type { GradingFeedback } from "../lib/grading-config";
interface GradingConfigurationSnapshot { readonly read: GradingConfigurationRead; readonly revision: number }
export function useGradingConfiguration(version: number | null) {
  const query = useQuery({ queryKey: ["oakridge", "grading-config", version], queryFn: () => readGradingConfiguration(version), refetchOnWindowFocus: false, refetchOnReconnect: false });
  const [snapshot, setSnapshot] = useState<GradingConfigurationSnapshot | null>(null);
  const [reloadFeedback, setReloadFeedback] = useState<GradingFeedback | null>(null);
  useEffect(() => {
    const result = query.data;
    if (result?.ok) setSnapshot((current) => current ?? { read: result.value, revision: 0 });
  }, [query.data]);
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
