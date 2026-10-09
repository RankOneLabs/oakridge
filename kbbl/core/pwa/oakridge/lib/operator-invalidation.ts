import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryKeys";

/** A launch or accepted command changes what the run list and the inbox show. */
export function invalidateRunLists(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.runs });
  void client.invalidateQueries({ queryKey: queryKeys.inbox });
}

/** A newly pinned definition joins the catalog the launch and definitions views read. */
export function invalidateDefinitions(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.definitions });
}
