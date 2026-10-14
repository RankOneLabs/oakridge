import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryKeys";
import { LiveSubscription } from "../../lib/live-stream";
import { invalidateOperatorTarget, parseInvalidationFrame } from "../lib/operator-invalidation";

/** Fallback refresh while no event arrives, using the configured interval. */
export function useOakridgeInvalidationStream(isEnabled: boolean, fallbackRefreshMs = 30_000): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!isEnabled) return;
    const authority = new LiveSubscription("/oakridge/api/events");
    authority.addEventListener("invalidate", (message) => {
      // A malformed frame is ignored; the fallback refresh remains active.
      const frame = parseInvalidationFrame(message.data);
      if (frame) invalidateOperatorTarget(client, frame);
    });
    return () => authority.close();
  }, [client, isEnabled]);
  useEffect(() => {
    const sessions = new LiveSubscription("/inbox");
    sessions.addEventListener("snapshot", () => { void client.invalidateQueries({ queryKey: ["sessions"] }); });
    return () => sessions.close();
  }, [client]);
  useEffect(() => {
    if (!isEnabled || !Number.isFinite(fallbackRefreshMs) || fallbackRefreshMs < 1_000) return;
    const timer = window.setInterval(() => { void client.invalidateQueries({ queryKey: queryKeys.operator }); }, fallbackRefreshMs);
    return () => window.clearInterval(timer);
  }, [client, isEnabled, fallbackRefreshMs]);
}
