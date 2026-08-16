import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { pingThread } from "../client";
import { selectThreadPingIdentity, type PendingThreadPingIdentity } from "../lib/thread-ping-idempotency";
export function usePingThread(_artifactId: string) {
  const pending = useRef<PendingThreadPingIdentity | null>(null);
  return useMutation({
    mutationFn: (threadId: string) => {
      pending.current = selectThreadPingIdentity(pending.current, threadId, () => crypto.randomUUID());
      return pingThread(threadId, pending.current.idempotency_key);
    },
    onSuccess: () => { pending.current = null; },
  });
}
