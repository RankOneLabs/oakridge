import { useQuery } from "@tanstack/react-query";
import { fetchArtifactTypes } from "../client";
export function useArtifactTypes() { return useQuery({ queryKey: ["oakridge", "artifact_types"], queryFn: fetchArtifactTypes, staleTime: 60_000 }); }
