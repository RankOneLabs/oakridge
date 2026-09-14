import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "vitest";

import type { SessionSnapshot } from "../../types";
import type { PwaSessionWorkflowIdentity } from "../../../acp/pwa-wire";
import { SessionRow } from "./SessionRow";

const TEMPLATED_NAME = "build-3f9e2b10-6c8b-4c1e-9a2b-1234567890ab-cohort-one";

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sid: "sid-1",
    name: TEMPLATED_NAME,
    agentProfile: "claude-code",
    status: "idle",
    source: "acp",
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
  test("renders the operator role in its own element and drops the raw templated name", () => {
    const workflow: PwaSessionWorkflowIdentity = {
      runId: "run-1", stageInstanceId: "3f9e2b10-6c8b-4c1e-9a2b-1234567890ab", unitId: "cohort-one",
      operatorRole: "build", cohortTitle: "Cohort One", repositoryKey: null,
    };
    renderRow(makeSnapshot({ workflow }));

    expect(screen.getByText("build")).toBeTruthy();
    expect(screen.queryByText(TEMPLATED_NAME)).toBeNull();
  });
});
