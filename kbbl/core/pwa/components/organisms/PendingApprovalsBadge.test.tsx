import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Sid } from "../../lib/ids";
import type { SessionSnapshot } from "../../types";
import { useStore } from "../../state/store";
import { PendingApprovalsBadge } from "./PendingApprovalsBadge";

const answer = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../hooks/useAcpSession", () => ({
  useAcpSession: () => ({
    historyLoaded: true,
    events: [
      { kind: "permission", requestId: "first", title: "Read files?", options: [{ optionId: "allow-first", name: "Allow read", kind: "allow_once" }] },
      { kind: "permission", requestId: "second", title: "Run tests?", options: [{ optionId: "allow-second", name: "Allow tests", kind: "allow_once" }, { optionId: "reject-second", name: "Reject tests", kind: "reject_once" }] },
    ],
  }),
}));
vi.mock("../../hooks/usePermissionAnswer", () => ({
  usePermissionAnswer: () => ({ isPending: false, mutateAsync: answer }),
}));

const waitingSession = (): SessionSnapshot => ({
  sid: "sid-waiting",
  name: "waiting session",
  agentProfile: "claude-code",
  status: "prompting",
  source: "acp",
  lastActivityTs: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  artifactId: null,
  projectWorkdir: "/repo",
  worktreePath: "/repo",
  worktreeBranch: null,
  worktreeBaseRef: null,
  requestedModel: null,
  requestedEffort: null,
  endReason: null,
  fencedBy: null,
  pendingPermissionCount: 1,
  workflow: null,
});

describe("PendingApprovalsBadge", () => {
  beforeEach(() => {
    answer.mockClear();
    window.location.hash = "";
    const snapshot = waitingSession();
    useStore.setState({ sessions: new Map([[snapshot.sid as Sid, snapshot]]) });
  });

  it("links to the selected permission inside its session", () => {
    render(<PendingApprovalsBadge />);

    fireEvent.click(screen.getAllByRole("button", { name: "Open in session" })[1]);

    expect(window.location.hash).toBe("#sid=sid-waiting&focus=permission&requestId=second");
  });

  it("answers with the exact option supplied by the agent", async () => {
    render(<PendingApprovalsBadge />);

    fireEvent.click(screen.getByRole("button", { name: "Allow tests" }));

    await waitFor(() => expect(answer).toHaveBeenCalledWith({ requestId: "second", optionId: "allow-second" }));
  });
});
