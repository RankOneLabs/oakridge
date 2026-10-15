import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeOakridgeStream } from "./useOakridgeRunEventStream";

export function useOakridgeInvalidationStream(isEnabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!isEnabled) return;
    const invalidate = () => { void client.invalidateQueries({ queryKey: ["oakridge"] }); };
    return subscribeOakridgeStream("invalidate", invalidate);
  }, [client, isEnabled]);
}
