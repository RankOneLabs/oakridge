import type { QueryClient } from "@tanstack/react-query";
import type { OperatorStreamInvalidation } from "../operator-contracts";
import { queryKeys } from "../queryKeys";

const INVALIDATION_TARGETS: readonly OperatorStreamInvalidation["target"][] = ["run", "runs", "definitions", "projects"];

const isInvalidationTarget = (value: unknown): value is OperatorStreamInvalidation["target"] =>
  INVALIDATION_TARGETS.some((target) => target === value);

/** An `invalidate` frame's data, or null for one this PWA does not understand. */
export function parseInvalidationFrame(data: string): OperatorStreamInvalidation | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "invalidate") return null;
    if (!("target" in value) || !isInvalidationTarget(value.target)) return null;
    if (!("run_id" in value) || (value.run_id !== null && typeof value.run_id !== "string")) return null;
    return { kind: "invalidate", target: value.target, run_id: value.run_id };
  } catch { return null; }
}

export function invalidateOperatorTarget(client: QueryClient, frame: OperatorStreamInvalidation): void {
  switch (frame.target) {
    case "run": if (frame.run_id !== null) invalidateRun(client, frame.run_id); return;
    case "runs": invalidateRunLists(client); return;
    case "definitions": invalidateDefinitions(client); return;
    case "projects": void client.invalidateQueries({ queryKey: queryKeys.projects }); return;
  }
}

/** A committed event on a run refreshes that run and both shared lists. */
export function invalidateRun(client: QueryClient, runId: string): void {
  void client.invalidateQueries({ queryKey: queryKeys.run(runId) });
  invalidateRunLists(client);
}

/** A launch or accepted decision changes what the run list and the inbox show. */
export function invalidateRunLists(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.runs });
  void client.invalidateQueries({ queryKey: queryKeys.inbox });
}

/** A newly pinned definition joins the catalog the launch and definitions views read. */
export function invalidateDefinitions(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: queryKeys.definitions });
}
