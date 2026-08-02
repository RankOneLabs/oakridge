import { useQuery } from "@tanstack/react-query";
import { fetchRunGates } from "../client";
export function useRunGates(runId: string) { return useQuery({ queryKey: ["oakridge", "run", runId, "gates"], queryFn: () => fetchRunGates(runId), refetchInterval: 10_000 }); }
