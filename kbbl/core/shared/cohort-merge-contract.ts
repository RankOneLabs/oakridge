export type MergeReviewThread = {
  id: string;
  author: string;
  firstLineSnippet: string;
  /** Path fragment; PWA prefixes with PR URL to compose the full deep-link. */
  deepLinkPath: string;
};

export type MergeBody = {
  confirm_unresolved?: boolean;
  confirm_closed?: boolean;
  confirm_threads_unknown?: boolean;
};

export type MergeOutcome =
  | { outcome: "already_done" }
  | { outcome: "merged"; via: "already_merged"; merged_at: string | null }
  | { outcome: "merged"; via: "merged_now" }
  | { outcome: "confirm_unresolved"; threads: MergeReviewThread[] }
  | { outcome: "confirm_threads_unknown" }
  | { outcome: "not_mergeable"; reason: "conflicts" | "checks_failing" | "unknown" }
  | { outcome: "confirm_closed" };
