import { useQuery } from "@tanstack/react-query";
import { readReviewer } from "../client-grading";

/** Who this server's grade capability answers as, so the panel can find the operator's own answers. */
export function useReviewer() {
  return useQuery({ queryKey: ["oakridge", "grading", "reviewer"], queryFn: readReviewer, retry: false, staleTime: 60_000 });
}
