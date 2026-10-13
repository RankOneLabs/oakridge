import { describe, expect, test } from "vitest";
import { makeBuildResultFixture } from "../__fixtures__/read-models";
import { selectBodyField, selectFieldText } from "../artifact-types";
import { selectOrderedIssues } from "./build-result";

describe("build result", () => {
  test("retains absent optional test text and metadata as null", () => {
    const { body } = makeBuildResultFixture();
    const tests = selectBodyField(body, "tests");
    const metadata = selectBodyField(body, "delegated_session_metadata");
    expect([tests && selectFieldText(tests, "summary"), metadata && selectFieldText(metadata, "branch")])
      .toEqual([null, null]);
  });

  test("orders issues blocking, warning, then info", () => {
    const { body } = makeBuildResultFixture({ known_issues: [
      { severity: "info", description: "a" }, { severity: "blocking", description: "b" },
      { severity: "warning", description: "c" },
    ] });
    expect(selectOrderedIssues(body).map((issue) => selectFieldText(issue, "description")))
      .toEqual(["b", "c", "a"]);
  });
});
