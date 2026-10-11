import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { makePrSummaryFixture } from "../__fixtures__/read-models";
import { selectFieldText, selectHttpUrl } from "../artifact-types";
import { PrSummaryViewer } from "../components/molecules/PrSummaryViewer";

afterEach(cleanup);

describe("checked pull request summary", () => {
  test("reads a missing review status as null", () => {
    const { body, schemas } = makePrSummaryFixture();
    expect(selectFieldText(body, schemas, "review_status")).toBeNull();
  });

  test("renders a GitHub pull request as a safe link", () => {
    const { body, schemas } = makePrSummaryFixture();
    render(createElement(PrSummaryViewer, { body, schemas }));
    expect(screen.getByRole("link", { name: "Open pull request" }).getAttribute("href"))
      .toBe("https://github.com/RankOneLabs/assay/pull/50");
  });

  test("leaves other URLs out of GitHub-specific presentation", () => {
    expect(selectHttpUrl("https://gitlab.com/a/b/-/merge_requests/1"))
      .toBe("https://gitlab.com/a/b/-/merge_requests/1");
  });

  test("refuses a javascript: URL", () => {
    expect(selectHttpUrl("javascript:alert(1)")).toBeNull();
  });
});
