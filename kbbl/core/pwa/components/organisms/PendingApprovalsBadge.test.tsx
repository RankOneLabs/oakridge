import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import type { Sid } from "../../lib/ids";
import type { SessionSnapshot } from "../../types";
import { useStore } from "../../state/store";
import { PendingApprovalsBadge } from "./PendingApprovalsBadge";

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
    window.location.hash = "";
    const snapshot = waitingSession();
    useStore.setState({ sessions: new Map([[snapshot.sid as Sid, snapshot]]) });
  });

  it("deep-links to the pending permission inside its session", () => {
    render(<PendingApprovalsBadge />);

    fireEvent.click(screen.getByRole("button", { name: /approval pending/i }));

    expect(window.location.hash).toBe("#sid=sid-waiting&focus=pending-permission");
  });
});
