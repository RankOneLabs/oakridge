import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReviewShell } from "./ReviewShell";
import type { ReviewShellProps } from "./types";

const baseProps: Omit<ReviewShellProps, "children"> = {
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

describe("ReviewShell", () => {
  it("renders back button, status text, mode toggle, and canvas slot", () => {
    render(
      <ReviewShell {...baseProps}>
        <div data-testid="stub-canvas" />
      </ReviewShell>,
    );

    expect(screen.getByRole("button", { name: /back/i })).toBeTruthy();
    expect(screen.getByText(/Plan review/)).toBeTruthy();
    expect(screen.getByText(/pending_approval/)).toBeTruthy();
    // ModeToggle renders "review" and "edit" buttons
    expect(screen.getByRole("button", { name: "review" })).toBeTruthy();
    expect(screen.getByTestId("stub-canvas")).toBeTruthy();
  });
});
