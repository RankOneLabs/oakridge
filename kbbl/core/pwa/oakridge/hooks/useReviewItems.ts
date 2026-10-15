import { useQuery } from "@tanstack/react-query";
import { fetchReviewItems } from "../client";
export function useReviewItems(artifactId: string, enabled = true) { return useQuery({ queryKey: ["oakridge", "artifact", artifactId, "review_items"], queryFn: () => fetchReviewItems(artifactId), refetchInterval: 10_000, enabled }); }
