import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { PrimaryNav } from "./PrimaryNav";

function renderNav(theme: "dark" | "light", onToggleTheme = () => {}) {
  render(
    <PrimaryNav
      activeSurface="runs"
      attentionCount={0}
      onNavigate={() => {}}
      theme={theme}
      onToggleTheme={onToggleTheme}
    />,
  );
}

describe("PrimaryNav theme toggle", () => {
  test("offers light mode while dark", () => {
    renderNav("dark");
    expect(screen.getByRole("button", { name: "Switch to light mode" }).textContent).toBe("LIGHT");
  });

  test("offers dark mode while light", () => {
    renderNav("light");
    expect(screen.getByRole("button", { name: "Switch to dark mode" }).textContent).toBe("DARK");
  });

  test("calls onToggleTheme when clicked", () => {
    const onToggleTheme = vi.fn();
    renderNav("dark", onToggleTheme);
    fireEvent.click(screen.getByRole("button", { name: "Switch to light mode" }));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
  });
});
