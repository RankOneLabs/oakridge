import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { StageStrip } from "../StageStrip";

const baseProps = {
  current_stage: "build" as const,
  spec_internal_status: "approved" as const,
  plan_status: "approved" as const,
  cohorts: [{ status: "done" }],
  assessment_present: false,
};

describe("StageStrip", () => {
  it("renders four tabs inside a tablist", () => {
    render(<StageStrip {...baseProps} />);
    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(4);
  });

  it("marks the current_stage tile with aria-current=step", () => {
    render(<StageStrip {...baseProps} current_stage="plan" />);
    const tabs = screen.getAllByRole("tab");
    const current = tabs.find((t) => t.getAttribute("aria-current") === "step");
    expect(current).toBeTruthy();
    expect(current?.textContent).toMatch(/Plan/i);
  });

  it("no tile has aria-selected=true when selected is undefined", () => {
    render(<StageStrip {...baseProps} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.every((t) => t.getAttribute("aria-selected") === "false")).toBe(true);
  });

  it("the matching tile gets aria-selected=true and --selected class when selected is set", () => {
    render(<StageStrip {...baseProps} selected="build" />);
    const tabs = screen.getAllByRole("tab");
    const selected = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toBeTruthy();
    expect(selected?.textContent).toMatch(/Build/i);
    expect(selected?.className).toContain("stage-strip__tile--selected");
  });

  it("calls onSelect with the stage when a tile is clicked", () => {
    const onSelect = vi.fn();
    render(<StageStrip {...baseProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("tab", { name: /Spec/i }));
    expect(onSelect).toHaveBeenCalledWith("spec");
  });

  it("clicking a tile is a no-op when onSelect is undefined", () => {
    render(<StageStrip {...baseProps} />);
    expect(() =>
      fireEvent.click(screen.getByRole("tab", { name: /Assess/i }))
    ).not.toThrow();
  });

  it("aria-current and aria-selected are independent", () => {
    render(<StageStrip {...baseProps} current_stage="build" selected="spec" />);
    const tabs = screen.getAllByRole("tab");
    const currentTab = tabs.find((t) => t.getAttribute("aria-current") === "step");
    const selectedTab = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    expect(currentTab?.textContent).toMatch(/Build/i);
    expect(selectedTab?.textContent).toMatch(/Spec/i);
  });
});
