import { useQuery } from "@tanstack/react-query";
import { fetchGates } from "../client";
export function useGates() { return useQuery({ queryKey: ["oakridge", "gates"], queryFn: fetchGates, refetchInterval: 10_000 }); }
