import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queryKeys";

/** The authority's invalidate frame targets only the query family it changed. */
export interface OperatorInvalidationFrame {
  readonly kind: "invalidate";
  readonly target: "run" | "runs" | "definitions" | "projects";
  readonly run_id: string | null;
  readonly replay: boolean;
}

export function invalidateOperatorEvent(client: QueryClient, frame: OperatorInvalidationFrame): void {
  if (frame.target === "run" && frame.run_id !== null) {
    void client.invalidateQueries({ queryKey: queryKeys.run(frame.run_id) });
    invalidateRunLists(client);
  }
  if (frame.target === "runs") invalidateRunLists(client);
  if (frame.target === "definitions") invalidateDefinitions(client);
  if (frame.target === "projects") void client.invalidateQueries({ queryKey: queryKeys.projects });
}

/** A launch or accepted command changes what the run list and the inbox show. */
export function invalidateRunLists(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.runs });
  void client.invalidateQueries({ queryKey: queryKeys.inbox });
}

/** A newly pinned definition joins the catalog the launch and definitions views read. */
export function invalidateDefinitions(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.definitions });
}
