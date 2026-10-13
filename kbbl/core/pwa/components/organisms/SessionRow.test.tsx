import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "vitest";

import type { SessionSnapshot } from "../../types";
import type { PwaSessionWorkflowIdentity } from "../../../acp/pwa-wire";
import { SessionRow } from "./SessionRow";

const SESSION_NAME = "builder · cohort/one";

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sid: "sid-1",
    name: SESSION_NAME,
    agentProfile: "claude-code",
    status: "idle",
    lastActivityTs: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    artifactId: null,
    projectWorkdir: "/repo",
    worktreePath: "/repo/worktree",
    worktreeBranch: null,
    worktreeBaseRef: null,
    requestedModel: null,
    requestedEffort: null,
    endReason: null,
    fencedBy: null,
    pendingPermissionCount: 0,
    workflow: null,
    ...overrides,
  };
}

function renderRow(snapshot: SessionSnapshot) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionRow snapshot={snapshot} onOpen={() => {}} onResume={() => {}} resumeDisabled={false} />
    </QueryClientProvider>,
  );
}

describe("SessionRow with a workflow identity", () => {
  test("renders the worker in its own element beside the session's name", () => {
    const workflow: PwaSessionWorkflowIdentity = { runId: "run-1", unitId: "run-1/cohort/one", worker: "builder" };
    renderRow(makeSnapshot({ workflow }));

    expect(screen.getByText("builder")).toBeTruthy();
    expect(screen.getByText(SESSION_NAME)).toBeTruthy();
  });
});
