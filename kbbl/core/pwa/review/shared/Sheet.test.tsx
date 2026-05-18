import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sheet } from "./Sheet";

describe("Sheet", () => {
  it("mounts hidden when open=false", () => {
    const { container } = render(
      <Sheet open={false} side="right" onClose={vi.fn()}>
        <div>Content</div>
      </Sheet>,
    );
    const sheet = container.querySelector(".sheet")!;
    expect(sheet.getAttribute("aria-hidden")).toBe("true");
    // open=false: no inline display:block override, so CSS display:none takes effect in real browsers
    expect(sheet.getAttribute("style")).toBeFalsy();
  });

  it("renders children when open=true", () => {
    render(
      <Sheet open={true} side="right" onClose={vi.fn()}>
        <div>Content</div>
      </Sheet>,
    );
    expect(screen.getByText("Content")).toBeTruthy();
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Sheet open={true} side="bottom" onClose={onClose}>
        <div>Content</div>
      </Sheet>,
    );
    const backdrop = container.querySelector(".sheet__backdrop")!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(
      <Sheet open={true} side="right" onClose={onClose}>
        <div>Content</div>
      </Sheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose on Escape when closed", () => {
    const onClose = vi.fn();
    render(
      <Sheet open={false} side="right" onClose={onClose}>
        <div>Content</div>
      </Sheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("traps Tab focus inside the panel", () => {
    render(
      <Sheet open={true} side="right" onClose={vi.fn()}>
        <button>A</button>
        <button>B</button>
        <button>C</button>
      </Sheet>,
    );
    const a = screen.getByText("A");
    const b = screen.getByText("B");
    const c = screen.getByText("C");
    // Initial focus lands on A (existing behaviour).
    expect(document.activeElement).toBe(a);
    // Tab from last (C) wraps to first (A).
    c.focus();
    fireEvent.keyDown(c, { key: "Tab" });
    expect(document.activeElement).toBe(a);
    // Shift+Tab from first (A) wraps to last (C).
    a.focus();
    fireEvent.keyDown(a, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(c);
    // Tab from middle (B) does not wrap — defer to browser default
    // (no preventDefault, no focus change in jsdom).
    b.focus();
    fireEvent.keyDown(b, { key: "Tab" });
    expect(document.activeElement).toBe(b);
  });
});
