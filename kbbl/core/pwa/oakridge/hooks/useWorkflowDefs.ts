import { useQuery } from "@tanstack/react-query";
import { fetchWorkflowDefs } from "../client";
export function useWorkflowDefs() { return useQuery({ queryKey: ["oakridge", "workflow_defs"], queryFn: fetchWorkflowDefs }); }
