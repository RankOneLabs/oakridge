import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import { readItemStatus, type ItemStatusRequest } from "../client-grading";

export interface ItemStatusOptions { readonly refetchInterval?: number | false }

/** No request, no read: the item is not captured yet. */
export function useItemStatus(request: ItemStatusRequest | null, { refetchInterval = 10_000 }: ItemStatusOptions = {}) {
  return useQuery({ queryKey: ["oakridge", "grading", "item-status", request],
    queryFn: request ? () => readItemStatus(request) : skipToken, placeholderData: keepPreviousData, refetchInterval });
}
