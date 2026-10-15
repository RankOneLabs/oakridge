import { useQuery } from "@tanstack/react-query";
import { fetchWorkflowDefs } from "../client";
export function useWorkflowDefs(includeArchived = false) { return useQuery({ queryKey: ["oakridge", "workflow_defs", includeArchived], queryFn: () => fetchWorkflowDefs(includeArchived) }); }
