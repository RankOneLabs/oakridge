import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { StructuredValue } from "./StructuredValue";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("nested fallback text starts clamped and expands independently", () => {
  // jsdom has no layout; model text that overflows the three-line clamp.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(60);
  const description = "A long task description. ".repeat(30);
  const detail = "Further captured context. ".repeat(30);
  render(<StructuredValue value={{ task_context: { description, notes: [detail] } }} />);

  expect(screen.getByText("Task context")).toBeTruthy();
  const [descriptionToggle, detailToggle] = screen.getAllByRole("button", { name: "Show more" });
  expect(descriptionToggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(descriptionToggle);
  expect(descriptionToggle.getAttribute("aria-expanded")).toBe("true");
  expect(detailToggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: "Show less" })).toBe(descriptionToggle);
  fireEvent.click(descriptionToggle);
  expect(screen.getAllByRole("button", { name: "Show more" })).toHaveLength(2);
});

test("short fallback scalars stay readable without expansion controls", () => {
  render(<StructuredValue value={{ description: "Short task", is_ready: true, count: 2, result: null }} />);
  for (const text of ["Short task", "true", "2", "None"]) expect(screen.getByText(text)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
});
