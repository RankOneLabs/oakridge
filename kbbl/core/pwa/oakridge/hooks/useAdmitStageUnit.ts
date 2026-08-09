import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { admitStageUnit } from "../client";

interface AdmitStageUnitRequest {
  stageId: string;
  unitId: string;
}

export function useAdmitStageUnit(runId: string) {
  const client = useQueryClient();
  const requestKeys = useRef(new Map<string, string>());
  return useMutation({
    mutationFn: ({ stageId, unitId }: AdmitStageUnitRequest) => {
      const identity = `${stageId}:${unitId}`;
      const key = requestKeys.current.get(identity) ?? crypto.randomUUID();
      requestKeys.current.set(identity, key);
      return admitStageUnit(stageId, unitId, key);
    },
    onSuccess: (_data, { stageId, unitId }) => {
      requestKeys.current.delete(`${stageId}:${unitId}`);
      void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
      void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
      void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
    },
  });
}
