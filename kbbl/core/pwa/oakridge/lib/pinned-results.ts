import type { ObservationScopedResult } from "../grading-contracts/grading/composite";

/** Pinned results without an answer remain visible independently of their subject scope. */
export const selectPinnedResults = (results: readonly ObservationScopedResult[]): readonly ObservationScopedResult[] =>
  results.filter((result) => result.status.state === "pinned");
