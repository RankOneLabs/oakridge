import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useOakridgeInvalidationStream(isEnabled: boolean): void {
  const client = useQueryClient();
  useEffect(() => {
    if (!isEnabled) return;
    const events = new EventSource("/oakridge/api/events");
    const invalidate = () => { void client.invalidateQueries({ queryKey: ["oakridge"] }); };
    events.addEventListener("invalidate", invalidate);
    return () => {
      events.removeEventListener("invalidate", invalidate);
      events.close();
    };
  }, [client, isEnabled]);
}
