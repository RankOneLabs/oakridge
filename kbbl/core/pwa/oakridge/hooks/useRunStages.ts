import { useQuery } from "@tanstack/react-query";
import { readRunStages } from "../client-grading";
export function useRunStages(run_id: string) {
  return useQuery({ queryKey: ["oakridge", "grading", "stages", run_id], queryFn: () => readRunStages(run_id), retry: false, refetchInterval: 10_000 });
}
