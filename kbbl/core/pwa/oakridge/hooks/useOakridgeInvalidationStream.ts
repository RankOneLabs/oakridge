import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** Refresh active projections while the backend has no event stream. */
export function useOakridgeInvalidationStream(isEnabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!isEnabled) return;
    const timer = window.setInterval(() => { void client.invalidateQueries({ queryKey: ["operator"] }); }, 10_000);
    return () => window.clearInterval(timer);
  }, [client, isEnabled]);
}
