import { useQuery } from "@tanstack/react-query";
import { readRunGrading } from "../client-grading";

export function useRunGrading(run_id: string) {
  return useQuery({ queryKey: ["oakridge", "grading", "run", run_id], queryFn: () => readRunGrading(run_id), retry: false, refetchInterval: 10_000 });
}
