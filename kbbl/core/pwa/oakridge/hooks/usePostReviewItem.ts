import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postReviewItem } from "../client";
import type { PostReviewItemRequest } from "../types";
export function usePostReviewItem(artifactId: string) { const client = useQueryClient(); return useMutation({ mutationFn: (request: PostReviewItemRequest) => postReviewItem(artifactId, request), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId, "review_items"] }); } }); }
