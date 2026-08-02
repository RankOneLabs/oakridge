import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createWorkflowDef } from "../client";
import type { WorkflowDefInput } from "../types";
export function useCreateWorkflowDef() { const client = useQueryClient(); return useMutation({ mutationFn: (input: WorkflowDefInput) => createWorkflowDef(input), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "workflow_defs"] }); } }); }
