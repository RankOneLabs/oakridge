import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CurrentAssessmentViewer } from "../components/molecules/CurrentAssessmentViewer";
import { CURRENT_ASSESSMENT, NOT_MET_ASSESSMENT } from "../__fixtures__/current-assessments";
afterEach(cleanup);
it("shows additional findings when all items are met without legacy sections", () => {
  render(<CurrentAssessmentViewer assessment={CURRENT_ASSESSMENT} />);
  fireEvent.click(screen.getByRole("tab", { name: /^Findings/ }));
  expect(screen.getByTestId("or-assessment-additional-findings").textContent).toContain("unrelated regression");
  expect(screen.queryByText("Task findings")).toBeNull(); expect(screen.queryByText("Cross-cutting findings")).toBeNull(); expect(screen.queryByText("Unresolved item references")).toBeNull();
});
it("observation grades remain distinct from assessor status", () => {
  render(<CurrentAssessmentViewer assessment={CURRENT_ASSESSMENT} />);
  expect(screen.getByLabelText("Assessor status").textContent).toBe("met");
  const itemGrades = screen.getAllByRole("region", { name: "Observation grade" }).length;
  fireEvent.click(screen.getByRole("tab", { name: /^Findings/ }));
  expect(itemGrades + screen.getAllByRole("region", { name: "Observation grade" }).length).toBe(2);
});
it("attention status filter excludes met items", () => {
  render(<CurrentAssessmentViewer assessment={{ ...NOT_MET_ASSESSMENT, item_assessments: [...NOT_MET_ASSESSMENT.item_assessments, { ...CURRENT_ASSESSMENT.item_assessments[0], subject: { kind: "build_item", id: "B2" } }] }} />);
  fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "needs_attention" } });
  expect(screen.getAllByTestId("or-criterion-check").map(item => item.getAttribute("data-status"))).toEqual(["not_met"]);
});
