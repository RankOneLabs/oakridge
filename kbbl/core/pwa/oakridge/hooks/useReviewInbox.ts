import { useQuery } from "@tanstack/react-query";

import { fetchReviewInbox } from "../client";

export function useReviewInbox(isEnabled = true) {
  return useQuery({
    queryKey: ["oakridge", "review-inbox"],
    queryFn: fetchReviewInbox,
    staleTime: 30_000,
    // The inbox has no refresh control: polling is how it picks up new work,
    // and recovers reviews missed while the event stream is disconnected.
    refetchInterval: 30_000,
    enabled: isEnabled,
  });
}
