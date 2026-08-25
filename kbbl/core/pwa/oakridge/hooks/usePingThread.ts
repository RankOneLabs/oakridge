import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { pingThread } from "../client";
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
