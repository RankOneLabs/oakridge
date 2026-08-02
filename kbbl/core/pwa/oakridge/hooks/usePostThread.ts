import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postThread } from "../client";
import type { PostThreadRequest } from "../types";
export function usePostThread(artifactId: string) { const client = useQueryClient(); return useMutation({ mutationFn: (request: PostThreadRequest) => postThread(artifactId, request), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId, "threads"] }); } }); }
