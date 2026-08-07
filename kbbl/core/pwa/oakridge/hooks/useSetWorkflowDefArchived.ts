import { useMutation, useQueryClient } from "@tanstack/react-query";
import { archiveWorkflowDef, unarchiveWorkflowDef } from "../client";
export function useSetWorkflowDefArchived() { const client = useQueryClient(); return useMutation({ mutationFn: ({ defId, archived }: { defId: string; archived: boolean }) => (archived ? archiveWorkflowDef(defId) : unarchiveWorkflowDef(defId)), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "workflow_defs"] }); } }); }
