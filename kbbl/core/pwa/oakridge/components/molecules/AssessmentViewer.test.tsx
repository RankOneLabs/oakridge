// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { makeAssessmentFixture } from "../../__fixtures__/read-models";
import { AssessmentViewer } from "./AssessmentViewer";

afterEach(cleanup);

describe("AssessmentViewer checked projection", () => {
  test("shows the assessment verdict", () => {
    const fixture = makeAssessmentFixture();
    render(<AssessmentViewer {...fixture} />);
    expect(screen.getByTestId("or-assessment-verdict").textContent).toBe("Fail");
  });

  test("lists findings from the assessment without looking up a brief", () => {
    const fixture = makeAssessmentFixture();
    render(<AssessmentViewer {...fixture} />);
    const findings = within(screen.getByTestId("or-assessment-attention"));
    expect(findings.getByText("Every fixture exists.")).toBeTruthy();
    expect(findings.getByText("B, E, F and G are missing.")).toBeTruthy();
  });

  test("shows the assessor's independent test evidence", () => {
    const fixture = makeAssessmentFixture();
    render(<AssessmentViewer {...fixture} />);
    expect(within(screen.getByTestId("or-assessment-test_evidence")).getByText("1274")).toBeTruthy();
  });

  test("keeps met findings folded until the operator asks", () => {
    const fixture = makeAssessmentFixture();
    render(<AssessmentViewer {...fixture} />);
    expect(screen.queryByText("Snapshot test passes.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show met criteria/ }));
    expect(screen.getByText("Snapshot test passes.")).toBeTruthy();
  });
});
