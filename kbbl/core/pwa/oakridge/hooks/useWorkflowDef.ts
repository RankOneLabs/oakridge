import { useQuery } from "@tanstack/react-query";
import { fetchWorkflowDef } from "../client";

export function useWorkflowDef(id: string | null) {
  return useQuery({
    queryKey: ["oakridge", "workflow_def", id],
    queryFn: () => {
      if (!id) throw new Error("A workflow definition ID is required");
      return fetchWorkflowDef(id);
    },
    enabled: Boolean(id),
  });
}
