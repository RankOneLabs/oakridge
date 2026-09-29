import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postMessage, postSessionMessage } from "../client";
import type { PostMessageRequest, PostSessionMessageRequest } from "../types";
export function usePostMessage(artifactId: string, threadId: string) { const client = useQueryClient(); return useMutation({ mutationFn: (request: PostMessageRequest) => postMessage(threadId, request), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId, "threads"] }); } }); }

export interface SendSessionMessage { readonly delivery_key: string; readonly message: PostSessionMessageRequest }
export function usePostSessionMessage(runId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: SendSessionMessage) => postSessionMessage(runId, request.delivery_key, request.message),
    onSuccess: (accepted) => {
      client.setQueryData(["oakridge", "run", runId, "message", accepted.message.delivery_key], accepted.message);
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId, "messages"] });
    },
  });
}
