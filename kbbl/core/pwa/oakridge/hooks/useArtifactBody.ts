import { useMutation, useQueryClient } from "@tanstack/react-query";
import { putArtifactRevisionBody } from "../client";

/** Publishes a successor to the displayed revision and refreshes its chain. */
export function useArtifactBody(revisionId: string, artifactId = revisionId) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: unknown) => putArtifactRevisionBody(revisionId, body),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId] }); },
  });
}
