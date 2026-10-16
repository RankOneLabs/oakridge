import { useQuery } from "@tanstack/react-query";

import { fetchReviewInbox } from "../client";

export function useReviewInbox(isEnabled = true) {
  return useQuery({
    queryKey: ["oakridge", "review-inbox"],
    queryFn: fetchReviewInbox,
    staleTime: 30_000,
    // Recover reviews missed while the event stream is disconnected.
    refetchInterval: 60_000,
    enabled: isEnabled,
  });
}
