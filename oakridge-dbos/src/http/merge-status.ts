import type { Hono } from "hono";
import type { PullRequestObservation } from "../domain/pull-request";
import type { PullRequestObserveInput } from "../operations/pull-request-observe";
import { OPERATION_KEYS } from "../operations/registry";
import type { OperationRunner } from "../operations/runner";
import type { Database } from "../storage/database";
import { readCommittedRunConfig, readMergeStatusSource, selectCommittedPrIntegration } from "../storage/read-store";
import type { MergeStatusSource } from "../storage/read-store";
import { errorResponse, MissingEntityError } from "./errors";

/** The live PR status shown before an operator confirms a merge. */
export type MergeStatusView =
  | { readonly kind: "merged"; readonly pr_url: string; readonly merged_at: string | null }
  | { readonly kind: "not_merged"; readonly pr_url: string; readonly state: "open" | "closed_unmerged" }
  | { readonly kind: "unavailable"; readonly detail: string };

type MergeObservation = Pick<PullRequestObservation, "state" | "url" | "merged_at">;
const isObservation = (value: unknown): value is MergeObservation =>
  value !== null && typeof value === "object" && "state" in value
  && (value.state === "open" || value.state === "merged" || value.state === "closed_unmerged")
  && "url" in value && typeof value.url === "string"
  && "merged_at" in value && (value.merged_at === null || typeof value.merged_at === "string");

export function selectMergeStatusInput(source: MergeStatusSource): PullRequestObserveInput | Extract<MergeStatusView, { kind: "unavailable" }> {
  if (!source.intent) return { kind: "unavailable", detail: "no pull request watch has been dispatched" };
  if (source.latest_revision_id === null || source.latest_revision_id !== source.intent.observed_revision_id) {
    return { kind: "unavailable", detail: "the pull request was republished; status returns after the next watch" };
  }
  return source.intent.input ?? { kind: "unavailable", detail: "recorded pull request watch query is malformed" };
}

export function installMergeStatus(app: Hono, deps: { readonly db: Database; readonly operations: OperationRunner | null }): void {
  app.get("/api/runs/:run_id/units/:unit_id/merge-status", async (c) => {
    const run_id = c.req.param("run_id"), unit_id = c.req.param("unit_id");
    try {
      const source = await readMergeStatusSource(deps.db, { run_id, unit_id });
      if (!source) return errorResponse(new MissingEntityError("unit not found"));
      const input = selectMergeStatusInput(source);
      if ("kind" in input) return c.json(input);
      if (!deps.operations) return c.json({ kind: "unavailable", detail: "PR status reader is not configured" } satisfies MergeStatusView);
      const pr_integration = selectCommittedPrIntegration(await readCommittedRunConfig(deps.db, run_id));
      if (pr_integration === null) return c.json({ kind: "unavailable", detail: "recorded run config is malformed" } satisfies MergeStatusView);
      const result = await deps.operations.run({ operation: OPERATION_KEYS.pull_request_observe, inputs: input },
        { signal: c.req.raw.signal, pr_integration });
      if (result.kind !== "succeeded") return c.json({ kind: "unavailable", detail: result.detail } satisfies MergeStatusView);
      if (!isObservation(result.body) || result.body.url !== input.query.pr_url)
        return c.json({ kind: "unavailable", detail: "PR status did not match the current pull request" } satisfies MergeStatusView);
      return result.body.state === "merged"
        ? c.json({ kind: "merged", pr_url: result.body.url, merged_at: result.body.merged_at } satisfies MergeStatusView)
        : c.json({ kind: "not_merged", pr_url: result.body.url, state: result.body.state } satisfies MergeStatusView);
    } catch (cause) { return c.json({ kind: "unavailable", detail: String(cause) } satisfies MergeStatusView); }
  });
}
