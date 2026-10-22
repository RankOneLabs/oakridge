import type { Hono } from "hono";
import type { PullRequestObservation } from "../domain/pull-request";
import { selectDevelopmentMergeQuery } from "../operations/pull-request-observe";
import { OPERATION_KEYS } from "../operations/registry";
import type { OperationRunner } from "../operations/runner";
import type { Database } from "../storage/database";
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

export function installMergeStatus(app: Hono, deps: { readonly db: Database; readonly operations: OperationRunner | null }): void {
  app.get("/api/runs/:run_id/units/:unit_id/merge-status", async (c) => {
    const run_id = c.req.param("run_id"), unit_id = c.req.param("unit_id");
    try {
      const unit = await deps.db.selectFrom("authority.unit").select(["stage", "input"])
        .where("run_id", "=", run_id).where("id", "=", unit_id).executeTakeFirst();
      if (!unit) return errorResponse(new MissingEntityError("unit not found"));
      const pr = await deps.db.selectFrom("authority.artifact_revision").select("body")
        .where("run_id", "=", run_id).where("unit_id", "=", unit_id).where("artifact", "=", "pr")
        .orderBy("seq", "desc").executeTakeFirst();
      const query = selectDevelopmentMergeQuery(unit.stage ?? "", unit.input, pr?.body ?? null);
      if (!query.ok) return c.json({ kind: "unavailable", detail: query.error } satisfies MergeStatusView);
      if (!deps.operations) return c.json({ kind: "unavailable", detail: "PR status reader is not configured" } satisfies MergeStatusView);
      const result = await deps.operations.run({ operation: OPERATION_KEYS.pull_request_observe, inputs: { query: query.value } },
        { signal: c.req.raw.signal });
      if (result.kind !== "succeeded") return c.json({ kind: "unavailable", detail: result.detail } satisfies MergeStatusView);
      if (!isObservation(result.body) || result.body.url !== query.value.pr_url)
        return c.json({ kind: "unavailable", detail: "PR status did not match the current pull request" } satisfies MergeStatusView);
      return result.body.state === "merged"
        ? c.json({ kind: "merged", pr_url: result.body.url, merged_at: result.body.merged_at } satisfies MergeStatusView)
        : c.json({ kind: "not_merged", pr_url: result.body.url, state: result.body.state } satisfies MergeStatusView);
    } catch (cause) { return c.json({ kind: "unavailable", detail: String(cause) } satisfies MergeStatusView); }
  });
}
