import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReviewShell } from "./ReviewShell";
import type { ReviewShellProps } from "./types";

function createBaseProps(): Omit<ReviewShellProps, "children"> {
  return {
    onBack: vi.fn(),
    artifactTypeLabel: "Plan review",
    statusLabel: "pending_approval",
    frozen: false,
    actionPending: false,
    isPendingApproval: true,
    onToggleTheme: vi.fn(),
    mode: "review",
    onModeChange: vi.fn(),
    onApprove: vi.fn(),
    onReject: vi.fn(),
    rejectSubjectLabel: "plan",
    approveSubjectLabel: "plan",
    artifactId: "aaaabbbbccccdddd",
    threads: [],
    selectedThreadId: null,
    threadMessages: new Map(),
    onSelectThread: vi.fn(),
    onCloseThread: vi.fn(),
    onNewThread: vi.fn(),
    onSendMessage: vi.fn(),
    onPing: vi.fn(),
    onResolve: vi.fn(),
  };
}

function renderShell(overrides?: Partial<Omit<ReviewShellProps, "children">>) {
  return render(
    <ReviewShell {...createBaseProps()} {...overrides}>
      <div data-testid="stub-canvas" />
    </ReviewShell>,
  );
}

describe("ReviewShell", () => {
  it("renders back button, status text, mode toggle, and canvas slot", () => {
    renderShell();

    expect(screen.getByRole("button", { name: /back/i })).toBeTruthy();
    expect(screen.getByText(/Plan review/)).toBeTruthy();
    expect(screen.getByText(/pending_approval/)).toBeTruthy();
    // ModeToggle renders "review" and "edit" buttons
    expect(screen.getByRole("button", { name: "review" })).toBeTruthy();
    expect(screen.getByTestId("stub-canvas")).toBeTruthy();
  });

  it("opens ApproveModal when Approve is clicked, calls onApprove on confirm", async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    renderShell({ onApprove });

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(screen.getByText(/Approve plan\?/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: /approve/i }).at(-1)!);
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("closes ApproveModal without calling onApprove when cancelled", () => {
    const onApprove = vi.fn();
    renderShell({ onApprove });

    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(screen.getByText(/Approve plan\?/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByText(/Approve plan\?/)).toBeFalsy();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("opens RejectModal when Reject is clicked, calls onReject with reason on confirm", () => {
    const onReject = vi.fn().mockResolvedValue(undefined);
    renderShell({ onReject });

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(screen.getByText(/Reject plan\?/)).toBeTruthy();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "not ready" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^reject$/i }).at(-1)!);
    expect(onReject).toHaveBeenCalledWith("not ready");
  });

  it("closes RejectModal without calling onReject when cancelled", () => {
    const onReject = vi.fn();
    renderShell({ onReject });

    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(screen.getByText(/Reject plan\?/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByText(/Reject plan\?/)).toBeFalsy();
    expect(onReject).not.toHaveBeenCalled();
  });
});
