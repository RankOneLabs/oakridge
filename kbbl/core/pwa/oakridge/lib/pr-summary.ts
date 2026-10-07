import type { Result } from "../../lib/result";
import type { PrReviewStatus, RepositoryKey } from "../types";

/**
 * Mirrors `PrSummaryBody` in oakridge-dbos/src/domain/dev-flow-artifacts.ts.
 * The build stage also publishes `base_branch` and `repository_key`, which the
 * dbos type does not declare; both read as null when absent.
 */
export interface PrSummary {
  pr_url: string;
  branch: string;
  summary: string;
  review_status: PrReviewStatus | null;
  base_branch: string | null;
  repository_key: RepositoryKey | null;
}

export interface PrSummaryParseError {
  operation: "parse_pr_summary";
  field: string;
  detail: string;
}

const REVIEW_STATUSES: readonly PrReviewStatus[] = ["draft", "ready", "changes_requested", "approved", "merged", "closed"];
const fail = (field: string, detail: string): Result<never, PrSummaryParseError> => ({ ok: false, error: { operation: "parse_pr_summary", field, detail } });

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function parsePrSummary(body: unknown): Result<PrSummary, PrSummaryParseError> {
  if (!isRecord(body)) return fail("body", "expected an object");
  for (const field of ["pr_url", "branch", "summary"] as const) {
    if (typeof body[field] !== "string") return fail(field, "expected a string");
  }
  return {
    ok: true,
    value: {
      pr_url: body.pr_url as string,
      branch: body.branch as string,
      summary: body.summary as string,
      review_status: REVIEW_STATUSES.find((status) => status === body.review_status) ?? null,
      base_branch: nullableText(body.base_branch),
      repository_key: nullableText(body.repository_key) as RepositoryKey | null,
    },
  };
}

/** Only http(s) URLs become links; anything else renders as text. */
export function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** `owner/repo #50` for a GitHub pull request URL, null for anything else. */
export function selectPullRequestLabel(url: string): string | null {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  return match ? `${match[1]}/${match[2]} #${match[3]}` : null;
}
