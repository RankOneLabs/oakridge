import { useQuery } from "@tanstack/react-query";
import { fetchOakridgeConfig } from "../client";
export function useOakridgeConfig() { return useQuery({ queryKey: ["oakridge", "config"], queryFn: fetchOakridgeConfig, staleTime: 30_000 }); }
