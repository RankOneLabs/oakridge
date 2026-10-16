import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateCachedRunUnits, refreshReviewInboxRun } from "../client";
import { replaceDevelopmentInboxRun } from "../adapters/inbox";
import type { OperatorStreamInvalidation } from "../operator-contracts";
import type { ReviewInbox } from "../types";
import { subscribeOakridgeStream } from "./useOakridgeRunEventStream";

export function useOakridgeInvalidationStream(isEnabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!isEnabled) return;
    let isActive = true;
    const latestRefresh = new Map<string, number>();
    const refreshRun = (runId: string) => {
      invalidateCachedRunUnits(runId);
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId, "gates"] });
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId, "sessions"] });
      void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
      const generation = (latestRefresh.get(runId) ?? 0) + 1;
      latestRefresh.set(runId, generation);
      const current = client.getQueryData<ReviewInbox>(["oakridge", "review-inbox"]);
      if (!current) return;
      void refreshReviewInboxRun(runId, current).then((updated) => {
        if (!isActive || latestRefresh.get(runId) !== generation) return;
        client.setQueryData<ReviewInbox>(["oakridge", "review-inbox"], (latest) =>
          latest ? replaceDevelopmentInboxRun(latest, runId, updated) : updated);
      }).catch(() => {
        if (isActive && latestRefresh.get(runId) === generation)
          void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
      });
    };
    const invalidate = (message: MessageEvent<string>) => {
      let frame: OperatorStreamInvalidation;
      try { frame = JSON.parse(message.data) as OperatorStreamInvalidation; } catch { return; }
      if (frame.kind !== "invalidate") return;
      const runId = frame.run_id;
      if (runId) refreshRun(runId);
      else {
        invalidateCachedRunUnits(null);
        void client.invalidateQueries({ queryKey: ["oakridge"] });
      }
    };
    // Normal commits publish run_event; invalidate covers faults, archives, and deletion.
    const runEvent = (message: MessageEvent<string>) => {
      let frame: unknown;
      try { frame = JSON.parse(message.data) as unknown; } catch { return; }
      if (frame && typeof frame === "object" && "run_id" in frame && typeof frame.run_id === "string")
        refreshRun(frame.run_id);
    };
    const stopInvalidations = subscribeOakridgeStream("invalidate", invalidate);
    const stopRunEvents = subscribeOakridgeStream("run_event", runEvent);
    return () => { isActive = false; stopRunEvents(); stopInvalidations(); };
  }, [client, isEnabled]);
}
