// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { makeSpecAnalysisFixture } from "../../__fixtures__/read-models";
import { SpecAnalysisViewer } from "./SpecAnalysisViewer";

afterEach(cleanup);

describe("SpecAnalysisViewer checked projection", () => {
  test("calls out blocking findings and blocked requirements together", () => {
    const fixture = makeSpecAnalysisFixture();
    render(<SpecAnalysisViewer {...fixture} />);
    const blockers = within(screen.getByTestId("or-spec-blockers"));
    expect(blockers.getByText("Schema conflict")).toBeTruthy();
    expect(blockers.getByText("Needs upstream API")).toBeTruthy();
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

  test("says so when no finding or requirement is blocking", () => {
    const fixture = makeSpecAnalysisFixture({ findings: [], requirements: [] });
    render(<SpecAnalysisViewer {...fixture} />);
    expect(screen.getByTestId("or-spec-no-blockers")).toBeTruthy();
  });

  test("shows source references from the checked body", () => {
    const fixture = makeSpecAnalysisFixture();
    render(<SpecAnalysisViewer {...fixture} />);
    expect(screen.queryByText("Brief §2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 source/ }));
    expect(within(screen.getByTestId("or-spec-sources")).getByText("Brief §2")).toBeTruthy();
  });
});
