import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import { readItemStatus, type ItemStatusRequest } from "../client-grading";

/** No request, no read: the item is not captured yet. */
export function useItemStatus(request: ItemStatusRequest | null) {
  return useQuery({ queryKey: ["oakridge", "grading", "item-status", request],
    queryFn: request ? () => readItemStatus(request) : skipToken, placeholderData: keepPreviousData, refetchInterval: 10_000 });
}
