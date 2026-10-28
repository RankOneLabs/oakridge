import { useQuery } from "@tanstack/react-query";
import { fetchRunSentFeedback } from "../client";
export function useRunSentFeedback(runId: string) { return useQuery({ queryKey: ["oakridge", "run", runId, "sent-feedback"], queryFn: () => fetchRunSentFeedback(runId), refetchInterval: 10_000 }); }
