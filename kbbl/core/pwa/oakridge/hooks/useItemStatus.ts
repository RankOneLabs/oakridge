import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { readItemStatus, type WindowQuery } from "../client-grading";
import type { PageWindow } from "../grading-types";

export function useItemStatus(occurrence_id: string | null, top: PageWindow, nested: WindowQuery) {
  return useQuery({ queryKey: ["oakridge", "grading", "item-status", occurrence_id, top, nested], enabled: occurrence_id !== null,
    queryFn: () => readItemStatus(occurrence_id ?? "", top, nested), placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
