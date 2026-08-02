import { useQuery } from "@tanstack/react-query";
import { fetchWorkflowDef } from "../client";
export function useWorkflowDef(id: string | null) { return useQuery({ queryKey: ["oakridge", "workflow_def", id], queryFn: () => fetchWorkflowDef(id as string), enabled: id !== null }); }
