import { useQuery } from "@tanstack/react-query";
import { fetchOperatorInbox } from "../client";

export function useReviewInbox(isEnabled = true) {
  return useQuery({ queryKey: ["operator", "inbox"], queryFn: fetchOperatorInbox, enabled: isEnabled });
}
