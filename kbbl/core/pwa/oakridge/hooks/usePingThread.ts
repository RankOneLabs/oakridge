import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { fetchSessionMessageDelivery, pingThread } from "../client";
import { selectRequestIdentity, type PendingRequestIdentity } from "../lib/request-identity";
import { randomUuid } from "../../lib/random-uuid";
export function usePingThread(_artifactId: string) {
  const pending = useRef<PendingRequestIdentity | null>(null);
  return useMutation({
    mutationFn: (threadId: string) => {
      pending.current = selectRequestIdentity(pending.current, threadId, randomUuid);
      return pingThread(threadId, pending.current.idempotency_key);
    },
    onSuccess: () => { pending.current = null; },
  });
}

/** Reads the backend's committed delivery result without inferring it from thread activity. */
export function useSessionMessageDelivery(runId: string, deliveryKey: string, enabled = true) {
  return useQuery({
    queryKey: ["oakridge", "run", runId, "message", deliveryKey],
    queryFn: () => fetchSessionMessageDelivery(runId, deliveryKey),
    enabled,
  });
}
