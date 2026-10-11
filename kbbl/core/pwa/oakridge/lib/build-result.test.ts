import { describe, expect, test } from "vitest";
import { makeBuildResultFixture } from "../__fixtures__/read-models";
import { selectCheckedField, selectFieldText } from "../artifact-types";
import { selectOrderedCheckedIssues } from "./build-result";

describe("checked build result", () => {
  test("retains absent optional test text and metadata as null", () => {
    const { body, schemas } = makeBuildResultFixture();
    const tests = selectCheckedField(body, schemas, "tests");
    const optionalMetadata = selectCheckedField(body, schemas, "delegated_session_metadata");
    const metadata = optionalMetadata?.data.kind === "optional" ? optionalMetadata.data.value : null;
    expect([tests && selectFieldText(tests, schemas, "summary"), metadata && selectFieldText(metadata, schemas, "branch")])
      .toEqual([null, null]);
  });

  test("orders checked issues blocking, warning, then info", () => {
    const { body, schemas } = makeBuildResultFixture({ known_issues: [
      { severity: "info", description: "a" }, { severity: "blocking", description: "b" },
      { severity: "warning", description: "c" },
    ] });
    expect(selectOrderedCheckedIssues(body, schemas).map((issue) => selectFieldText(issue, schemas, "description")))
      .toEqual(["b", "c", "a"]);
  });
});
