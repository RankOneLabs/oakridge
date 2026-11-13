import { skipToken, useQuery } from "@tanstack/react-query";
import { readExecutedPrompt } from "../client";

export function useExecutedPrompt(session_id: string | null) {
  return useQuery({ queryKey: ["oakridge", "executed-prompt", session_id],
    queryFn: session_id === null ? skipToken : () => readExecutedPrompt(session_id), retry: false, refetchInterval: 10_000 });
}
