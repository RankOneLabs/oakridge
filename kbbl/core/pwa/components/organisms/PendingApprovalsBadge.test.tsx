import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_SESSION_LIVE_STATE, permissionRequestId, transcriptItemId, transcriptSeq, type PermissionItem } from "../../../acp/transcript-model";
import { applyIncrementalFrames } from "../../lib/session-frames";
import { INITIAL_SESSION_TRANSCRIPT_STATE } from "../../state/session-transcript-store";
import type { Sid } from "../../lib/ids";
import type { SessionSnapshot } from "../../types";
import { useStore } from "../../state/store";
import { PendingApprovalsBadge } from "./PendingApprovalsBadge";

const answer = vi.hoisted(() => vi.fn(async () => {}));
const first: PermissionItem = {
  id: transcriptItemId(transcriptSeq(0)), seq: transcriptSeq(0), kind: "permission",
  request_id: permissionRequestId("first"), title: "Read files?", resolution: null,
  options: [{ option_id: "allow-first", name: "Allow read", kind: "allow_once" }],
};
const second: PermissionItem = {
  id: transcriptItemId(transcriptSeq(1)), seq: transcriptSeq(1), kind: "permission",
  request_id: permissionRequestId("second"), title: "Run tests?", resolution: null,
  options: [
    { option_id: "allow-second", name: "Allow tests", kind: "allow_once" },
    { option_id: "reject-second", name: "Reject tests", kind: "reject_once" },
  ],
};
let stream = INITIAL_SESSION_TRANSCRIPT_STATE;
function receivePermissions(open_permissions: readonly PermissionItem[]) {
  stream = applyIncrementalFrames(stream, [{ kind: "session_state", state: { ...EMPTY_SESSION_LIVE_STATE, open_permissions } }]);
}
vi.mock("../../hooks/useAcpSession", () => ({
  useAcpSession: () => ({ historyLoaded: true, sessionState: stream.session_state }),
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
    archivedAt: null,
  pendingPermissionCount: 1,
  workflow: null,
});

describe("PendingApprovalsBadge", () => {
  beforeEach(() => {
    answer.mockClear();
    receivePermissions([first, second]);
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
  it("retires only the request absent from the next session_state frame", () => {
    receivePermissions([]);
    const { rerender } = render(<PendingApprovalsBadge />);
    expect(screen.queryByRole("button", { name: "Allow read" })).toBeNull();

    receivePermissions([first, second]);
    rerender(<PendingApprovalsBadge />);
    expect(screen.getByRole("button", { name: "Allow read" })).toBeTruthy();

    receivePermissions([second]);
    rerender(<PendingApprovalsBadge />);

    expect(screen.queryByRole("button", { name: "Allow read" })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow tests" })).toBeTruthy();
  });
});
