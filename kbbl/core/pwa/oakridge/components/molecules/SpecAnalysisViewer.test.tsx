// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { makeSpecAnalysisFixture } from "../../__fixtures__/read-models";
import { SpecAnalysisViewer } from "./SpecAnalysisViewer";

afterEach(cleanup);

describe("SpecAnalysisViewer checked projection", () => {
  test("shows blocking findings and requirements in their checked sections", () => {
    const fixture = makeSpecAnalysisFixture();
    render(<SpecAnalysisViewer {...fixture} />);
    expect(within(screen.getByTestId("or-spec-findings")).getByText("Schema conflict")).toBeTruthy();
    expect(within(screen.getByTestId("or-spec-requirements")).getByText("Needs upstream API")).toBeTruthy();
  });

  test("shows each risk's mitigation", () => {
    const fixture = makeSpecAnalysisFixture();
    render(<SpecAnalysisViewer {...fixture} />);
    expect(within(screen.getByTestId("or-risk-card")).getByText("Mitigation: Backfill in batches")).toBeTruthy();
  });

  test("does not repeat a finding", () => {
    const fixture = makeSpecAnalysisFixture();
    render(<SpecAnalysisViewer {...fixture} />);
    expect(screen.getAllByText("Schema conflict")).toHaveLength(1);
  });

  test("shows source references from the checked body", () => {
    const fixture = makeSpecAnalysisFixture();
    render(<SpecAnalysisViewer {...fixture} />);
    expect(within(screen.getByTestId("or-spec-sources")).getByText("Brief §2")).toBeTruthy();
  });
});
