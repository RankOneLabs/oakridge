import { describe, expect, test } from "vitest";
import { isWebUrl, parsePrSummary, selectPullRequestLabel } from "./pr-summary";

const body = {
  change_request_link: "https://github.com/RankOneLabs/assay/pull/50",
  branch: "cohort/run/cm-api",
  summary: "Adds analyze().",
  base_branch: "epic/metrics-update",
  repository_key: "assay",
};

describe("parsePrSummary", () => {
  test("reads the base branch the build stage publishes", () => {
    const parsed = parsePrSummary(body, "change_request_link");
    expect(parsed.ok && parsed.value.base_branch).toBe("epic/metrics-update");
  });

  test("reads a missing review status as null", () => {
    const parsed = parsePrSummary(body, "change_request_link");
    expect(parsed.ok && parsed.value.review_status).toBeNull();
  });

  test("names a missing required field", () => {
    const parsed = parsePrSummary({ ...body, branch: undefined }, "change_request_link");
    expect(parsed.ok ? null : parsed.error.field).toBe("branch");
  });
});

describe("selectPullRequestLabel", () => {
  test("shortens a GitHub pull request URL", () => {
    expect(selectPullRequestLabel(body.change_request_link)).toBe("RankOneLabs/assay #50");
  });

  test("leaves other URLs alone", () => {
    expect(selectPullRequestLabel("https://gitlab.com/a/b/-/merge_requests/1")).toBeNull();
  });
});

describe("isWebUrl", () => {
  test("refuses a javascript: URL", () => {
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
  });
});
