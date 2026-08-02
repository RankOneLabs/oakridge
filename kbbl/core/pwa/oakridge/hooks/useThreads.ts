import { useQuery } from "@tanstack/react-query";
import { fetchThreads } from "../client";
export function useThreads(artifactId: string, enabled = true) { return useQuery({ queryKey: ["oakridge", "artifact", artifactId, "threads"], queryFn: () => fetchThreads(artifactId), refetchInterval: 10_000, enabled }); }
