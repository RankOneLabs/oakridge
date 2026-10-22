import { useQuery } from "@tanstack/react-query";
import { fetchOperatorDefinition } from "../client";

export function useOperatorDefinition(id: string) {
  return useQuery({ queryKey: ["oakridge", "operator_definition", id], queryFn: () => fetchOperatorDefinition(id), enabled: !!id });
}
