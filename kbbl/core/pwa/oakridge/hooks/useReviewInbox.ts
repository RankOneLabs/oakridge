import { useQuery } from "@tanstack/react-query";

import { fetchReviewInbox } from "../client";

export function useReviewInbox() {
  return useQuery({
    queryKey: ["oakridge", "review-inbox"],
    queryFn: fetchReviewInbox,
    refetchInterval: 10_000,
  });
}
