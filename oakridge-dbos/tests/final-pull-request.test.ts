import { expect, test } from "bun:test";

import { selectFinalPullRequestObservationOutcome, selectFinalPullRequestStageConfig } from "../src/domain/final-pull-request";
import { parseGithubPullRequestIdentity, type PullRequestObservation } from "../src/domain/pull-request";

const observation = (state: PullRequestObservation["state"]): PullRequestObservation => ({
  provider: "github", owner: "acme", name: "api", number: 42, url: "https://github.com/acme/api/pull/42",
  head_branch: "epic/parity", base_branch: "main", head_sha: "abc", state, source: "webhook",
  observed_at: "2026-08-15T01:00:00Z", merged_at: state === "merged" ? "2026-08-15T01:00:00Z" : null,
});

test("canonical GitHub pull request identity accepts only the exact URL shape", () => {
  expect(parseGithubPullRequestIdentity("https://github.com/acme/api/pull/42/")).toEqual({ owner: "acme", name: "api", number: 42 });
  for (const invalid of ["http://github.com/acme/api/pull/42", "https://github.com/acme/api/issues/42", "https://github.com/acme/api/pull/0", "https://github.com/acme/api/pull/42/files"]) {
    expect(parseGithubPullRequestIdentity(invalid)).toBeNull();
  }
});

test("final-stage observation outcomes are selected from the shared observation", () => {
  expect(selectFinalPullRequestObservationOutcome(observation("open"))).toBe("waiting");
  expect(selectFinalPullRequestObservationOutcome(observation("merged"))).toBe("merged_evidence");
  expect(selectFinalPullRequestObservationOutcome(observation("closed_unmerged"))).toBe("closed_without_merge");
});

test("the final-stage adapter maps the base branch onto the repository integration target", () => {
  expect(selectFinalPullRequestStageConfig({ final_merge_policy: "external_confirmation" }, { integration_branch: "main" },
    { base_branch: "epic/work" })).toEqual({ canonical_ref: "epic/work", expected_pr_base: "main", merge_policy: "external_confirmation" });
});
