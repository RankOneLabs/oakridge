// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ExpandableText } from "./ExpandableText";

// jsdom lays nothing out, so stand in for a clamp that does or does not hide text.
function stubLayout({ scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(scrollHeight);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(clientHeight);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ExpandableText", () => {
  test("offers no toggle when the text fits", () => {
    stubLayout({ scrollHeight: 60, clientHeight: 60 });
    render(<ExpandableText text="Short." />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("expands clamped text on click", () => {
    stubLayout({ scrollHeight: 200, clientHeight: 60 });
    render(<ExpandableText text="A long paragraph." />);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });
});
