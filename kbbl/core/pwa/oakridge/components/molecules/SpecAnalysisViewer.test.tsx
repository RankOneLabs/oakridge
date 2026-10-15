// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { SpecAnalysisViewer } from "./SpecAnalysisViewer";

const body = {
  summary: "The brief is mostly implementable.",
  source_spec_refs: ["Brief §2"],
  findings: [
    { id: "f1", description: "Schema conflict", severity: "blocking" },
    { id: "f2", description: "Naming drift", severity: "warning" },
  ],
  requirements: [
    { id: "r1", description: "Needs upstream API", status: "blocked" },
    { id: "r2", description: "Add the column", status: "implementable" },
  ],
  risks: [{ description: "Migration locks the table", mitigation: "Backfill in batches" }],
};

afterEach(cleanup);

describe("SpecAnalysisViewer", () => {
  test("calls out blocking findings and blocked requirements together", () => {
    render(<SpecAnalysisViewer body={body} />);
    const blockers = screen.getByTestId("or-spec-blockers");
    expect([within(blockers).queryByText("Schema conflict"), within(blockers).queryByText("Needs upstream API")]).not.toContain(null);
  });

  test("shows each risk's mitigation", () => {
    render(<SpecAnalysisViewer body={body} />);
    expect(within(screen.getByTestId("or-risk-card")).getByText("Backfill in batches")).toBeTruthy();
  });

  test("lists a blocker only in the callout", () => {
    render(<SpecAnalysisViewer body={body} />);
    expect(screen.getAllByText("Schema conflict")).toHaveLength(1);
  });

  test("says so when nothing is blocking", () => {
    render(<SpecAnalysisViewer body={{ ...body, findings: [], requirements: [] }} />);
    expect(screen.getByTestId("or-spec-no-blockers")).toBeTruthy();
  });

  test("keeps sources behind a toggle that names the count", () => {
    render(<SpecAnalysisViewer body={body} />);
    expect(screen.queryByText("Brief §2")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 source/ }));
    expect(screen.getByText("Brief §2")).toBeTruthy();
  });

  test("reports a body that breaks the contract", () => {
    render(<SpecAnalysisViewer body={{ summary: "Missing arrays" }} />);
    expect(screen.getByRole("alert").textContent).toContain("does not match the registered contract");
  });
});
