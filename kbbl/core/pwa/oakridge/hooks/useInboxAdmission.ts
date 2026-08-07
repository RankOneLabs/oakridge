import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { admitStageUnit } from "../client";

interface InboxAdmissionRequest {
  stageId: string;
  unitId: string;
}

export function useInboxAdmission() {
  const client = useQueryClient();
  const requestKeys = useRef(new Map<string, string>());

  return useMutation({
    mutationFn: ({ stageId, unitId }: InboxAdmissionRequest) => {
      const identity = `${stageId}:${unitId}`;
      const idempotencyKey = requestKeys.current.get(identity) ?? crypto.randomUUID();
      requestKeys.current.set(identity, idempotencyKey);
      return admitStageUnit(stageId, unitId, idempotencyKey);
    },
    onSuccess: (_data, request) => {
      requestKeys.current.delete(`${request.stageId}:${request.unitId}`);
      void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
      void client.invalidateQueries({ queryKey: ["oakridge", "runs"] });
    },
  });
}
