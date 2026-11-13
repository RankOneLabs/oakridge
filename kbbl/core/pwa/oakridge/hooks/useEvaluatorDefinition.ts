import { useQuery } from "@tanstack/react-query";
import { readEvaluatorDefinition } from "../client-grading";

export function useEvaluatorDefinition(evaluator_id: string) {
  return useQuery({ queryKey: ["oakridge", "grading", "evaluator-definition", evaluator_id],
    queryFn: () => readEvaluatorDefinition(evaluator_id), retry: false, staleTime: Infinity });
}
