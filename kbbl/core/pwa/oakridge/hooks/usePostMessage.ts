import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postMessage } from "../client";
import type { PostMessageRequest } from "../types";
export function usePostMessage(artifactId: string, threadId: string) { const client = useQueryClient(); return useMutation({ mutationFn: (request: PostMessageRequest) => postMessage(threadId, request), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId, "threads"] }); } }); }
