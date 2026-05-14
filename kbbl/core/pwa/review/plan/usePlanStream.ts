import { useArtifactStream, type ArtifactStreamState } from "../shared/useArtifactStream";

export function usePlanStream(planId: string): ArtifactStreamState {
  return useArtifactStream({ type: "plan", id: planId });
}
