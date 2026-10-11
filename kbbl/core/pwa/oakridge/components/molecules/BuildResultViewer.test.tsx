// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { makeBuildResultFixture } from "../../__fixtures__/read-models";
import { BuildResultViewer } from "./BuildResultViewer";

afterEach(cleanup);

describe("BuildResultViewer checked projection", () => {
  test("lists a blocking issue with its severity", () => {
    const fixture = makeBuildResultFixture();
    render(<BuildResultViewer {...fixture} />);
    const issues = within(screen.getByTestId("or-build-known_issues"));
    expect(issues.getByText("Fixture table incomplete.")).toBeTruthy();
    expect(issues.getByText("blocking")).toBeTruthy();
  });

  test("lists changed files without a brief lookup", () => {
    const fixture = makeBuildResultFixture();
    render(<BuildResultViewer {...fixture} />);
    const files = within(screen.getByTestId("or-build-changed_files"));
    expect(files.getByText("src/api.py")).toBeTruthy();
    expect(files.getByText("ci.yml")).toBeTruthy();
  });

  test("shows reported test counts", () => {
    const fixture = makeBuildResultFixture();
    render(<BuildResultViewer {...fixture} />);
    const tests = within(screen.getByTestId("or-build-tests"));
    expect(tests.getByText("78")).toBeTruthy();
    expect(tests.getByText("0")).toBeTruthy();
  });

  test("shows blocking issues before less urgent issues", () => {
    const fixture = makeBuildResultFixture({ known_issues: [
      { severity: "info", description: "Info" }, { severity: "blocking", description: "Blocker" },
    ] });
    render(<BuildResultViewer {...fixture} />);
    expect(within(screen.getByTestId("or-build-known_issues")).getAllByRole("listitem")
      .map((item) => item.textContent?.includes("Blocker"))).toEqual([true, false]);
  });
});
