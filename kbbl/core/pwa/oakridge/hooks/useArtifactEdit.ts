import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OperatorArtifactRevisionView, OperatorBodyValue } from "../operator-contracts";
import { publishOperatorEdit } from "../client";
import { invalidateRunDetail } from "../lib/operator-invalidation";
import { randomUuid } from "../../lib/random-uuid";

interface ArtifactEditInput { readonly revision: OperatorArtifactRevisionView; readonly body: OperatorBodyValue }
/** Publish the operator's edit as the revision after the one edited, reviewing what it reviewed. */
export function useArtifactEdit() {
  const client = useQueryClient();
  return useMutation({ mutationFn: async ({ revision, body }: ArtifactEditInput) => {
    const receipt = await publishOperatorEdit({ run_id: revision.run_id, unit_id: revision.unit_id, artifact_key: revision.artifact_key,
      request_id: randomUuid(), body, predecessor: revision.id, subject: revision.subject_id });
    return receipt;
  }, onSuccess: (_receipt, { revision }) => invalidateRunDetail(client, revision.run_id) });
}
