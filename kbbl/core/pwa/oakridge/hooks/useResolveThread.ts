import { useMutation, useQueryClient } from "@tanstack/react-query";
import { resolveThread } from "../client";
export function useResolveThread(artifactId: string) { const client = useQueryClient(); return useMutation({ mutationFn: (threadId: string) => resolveThread(threadId), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId, "threads"] }); } }); }
