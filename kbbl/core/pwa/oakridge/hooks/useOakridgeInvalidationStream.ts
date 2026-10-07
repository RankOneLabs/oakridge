import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryKeys";
import type { RunEventFrame } from "../types";

/** An authority event refreshes the affected run and both shared lists. */
export function invalidateOperatorFrame(client: QueryClient, frame: RunEventFrame): void {
  void client.invalidateQueries({ queryKey: queryKeys.run(frame.run_id) });
  void client.invalidateQueries({ queryKey: queryKeys.runs });
  void client.invalidateQueries({ queryKey: queryKeys.inbox });
}

/** Fallback refresh while no event arrives, using the configured interval. */
export function useOakridgeInvalidationStream(isEnabled: boolean, fallbackRefreshMs = 30_000): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!isEnabled || !Number.isFinite(fallbackRefreshMs) || fallbackRefreshMs < 1_000) return;
    const timer = window.setInterval(() => { void client.invalidateQueries({ queryKey: queryKeys.operator }); }, fallbackRefreshMs);
    return () => window.clearInterval(timer);
  }, [client, isEnabled, fallbackRefreshMs]);
}
