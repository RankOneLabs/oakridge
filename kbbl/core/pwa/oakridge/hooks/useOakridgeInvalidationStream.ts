import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryKeys";
import type { OperatorRunEvent } from "../operator-contracts";
import { LiveSubscription } from "../../lib/live-stream";
import { invalidateOperatorEvent, type OperatorInvalidationFrame } from "../lib/operator-invalidation";

/** An authority event refreshes the affected run and both shared lists. */
export function invalidateOperatorFrame(client: QueryClient, event: OperatorRunEvent): void {
  void client.invalidateQueries({ queryKey: queryKeys.run(event.run_id) });
  void client.invalidateQueries({ queryKey: queryKeys.runs });
  void client.invalidateQueries({ queryKey: queryKeys.inbox });
}

/** Fallback refresh while no event arrives, using the configured interval. */
export function useOakridgeInvalidationStream(isEnabled: boolean, fallbackRefreshMs = 30_000): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!isEnabled) return;
    const authority = new LiveSubscription("/oakridge/api/events");
    authority.addEventListener("invalidate", (message) => {
      try {
        const frame: unknown = JSON.parse(message.data);
        if (frame && typeof frame === "object" && "kind" in frame && frame.kind === "invalidate"
          && "target" in frame && ["run", "runs", "definitions", "projects"].includes(String(frame.target))
          && "run_id" in frame && (frame.run_id === null || typeof frame.run_id === "string")) {
          invalidateOperatorEvent(client, frame as OperatorInvalidationFrame);
        }
      } catch { /* Ignore a malformed frame; the fallback refresh remains active. */ }
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
