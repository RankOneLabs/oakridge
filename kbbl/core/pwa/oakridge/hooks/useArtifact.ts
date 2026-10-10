import { useQuery } from "@tanstack/react-query";
import { fetchOperatorArtifactRevision } from "../client";
import { queryKeys } from "../queryKeys";

export const useArtifact = (revisionId: string) => useQuery({
  queryKey: queryKeys.artifact(revisionId), queryFn: () => fetchOperatorArtifactRevision(revisionId),
});
