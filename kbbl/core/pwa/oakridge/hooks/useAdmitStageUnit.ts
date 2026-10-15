import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { admitStageUnit } from "../client";
import { selectRequestIdentity, type PendingRequestIdentity } from "../lib/request-identity";
import { randomUuid } from "../../lib/random-uuid";

interface AdmitStageUnitRequest {
  stageId: string;
  unitId: string;
}

export function useAdmitStageUnit(runId: string) {
  const client = useQueryClient();
  const requestKeys = useRef(new Map<string, PendingRequestIdentity>());
  return useMutation({
    mutationFn: ({ stageId, unitId }: AdmitStageUnitRequest) => {
      const identity = `${stageId}:${unitId}`;
      const pending = selectRequestIdentity(requestKeys.current.get(identity) ?? null, identity, randomUuid);
      requestKeys.current.set(identity, pending);
      return admitStageUnit(stageId, unitId, pending.idempotency_key);
    },
    onSuccess: (_data, { stageId, unitId }) => {
      requestKeys.current.delete(`${stageId}:${unitId}`);
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
      void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
      void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
    },
  });
}
