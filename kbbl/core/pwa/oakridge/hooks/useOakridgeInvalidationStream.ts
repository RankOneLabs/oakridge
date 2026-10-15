import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateCachedRunUnits, refreshReviewInboxRun } from "../client";
import type { OperatorStreamInvalidation } from "../operator-contracts";
import type { ReviewInbox } from "../types";
import { subscribeOakridgeStream } from "./useOakridgeRunEventStream";

export function useOakridgeInvalidationStream(isEnabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!isEnabled) return;
    const invalidate = (message: MessageEvent<string>) => {
      let frame: OperatorStreamInvalidation;
      try { frame = JSON.parse(message.data) as OperatorStreamInvalidation; } catch { return; }
      if (frame.kind !== "invalidate") return;
      invalidateCachedRunUnits(frame.run_id);
      if (frame.run_id) {
        void client.invalidateQueries({ queryKey: ["oakridge", "run", frame.run_id] });
        void client.invalidateQueries({ queryKey: ["oakridge", "run", frame.run_id, "gates"] });
        void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
        const current = client.getQueryData<ReviewInbox>(["oakridge", "review-inbox"]);
        if (current) void refreshReviewInboxRun(frame.run_id, current).then((updated) => {
          client.setQueryData(["oakridge", "review-inbox"], updated);
        }).catch(() => { void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] }); });
      } else {
        void client.invalidateQueries({ queryKey: ["oakridge"] });
      }
    };
    return subscribeOakridgeStream("invalidate", invalidate);
  }, [client, isEnabled]);
}
