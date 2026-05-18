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
});
