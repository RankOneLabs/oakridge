import { useQuery } from "@tanstack/react-query";
import { readRunUsage } from "../client";

export function useRunUsage(run_id: string) {
  return useQuery({ queryKey: ["oakridge", "usage", "run", run_id], queryFn: () => readRunUsage(run_id), retry: false, refetchInterval: 10_000 });
}
