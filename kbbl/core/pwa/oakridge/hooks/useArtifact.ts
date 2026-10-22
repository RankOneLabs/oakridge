import { useQuery } from "@tanstack/react-query";
import { fetchArtifact } from "../client";
export function useArtifact(id: string, enabled = true) { return useQuery({ queryKey: ["oakridge", "artifact", id], queryFn: () => fetchArtifact(id), refetchInterval: 10_000, enabled }); }
