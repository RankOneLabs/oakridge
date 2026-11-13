import { useQuery } from "@tanstack/react-query";
import { readGradingConfiguration } from "../client-grading-config";
export function useGradingConfiguration(version: number | null) {
  return useQuery({ queryKey: ["oakridge", "grading-config", version], queryFn: () => readGradingConfiguration(version), refetchOnWindowFocus: false, refetchOnReconnect: false });
}
