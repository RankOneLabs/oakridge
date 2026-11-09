import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readRunFindings } from "../client-grading";
import type { PageWindow } from "../grading-types";

export function useRunFindings(run_id: string, query: { readonly stage: string; readonly is_current_only: boolean; readonly page: PageWindow; readonly links: PageWindow }) {
  return useQuery({ queryKey: ["oakridge", "grading", "findings", run_id, query], queryFn: () => readRunFindings(run_id, query), retry: false,
    placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
