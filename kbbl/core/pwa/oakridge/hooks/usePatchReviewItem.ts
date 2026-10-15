import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patchReviewItem } from "../client";
import type { PatchReviewItemRequest } from "../types";
export function usePatchReviewItem(artifactId: string) { const client = useQueryClient(); return useMutation({ mutationFn: ({ id, req }: { id: string; req: PatchReviewItemRequest }) => patchReviewItem(id, req), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId, "review_items"] }); } }); }
