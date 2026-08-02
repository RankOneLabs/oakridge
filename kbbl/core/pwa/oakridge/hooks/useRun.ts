import { useQuery } from "@tanstack/react-query";
import { fetchRun } from "../client";
export function useRun(id: string) { return useQuery({ queryKey: ["oakridge", "run", id], queryFn: () => fetchRun(id), refetchInterval: 10_000 }); }
