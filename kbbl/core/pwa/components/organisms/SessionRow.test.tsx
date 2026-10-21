import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, test, vi } from "vitest";

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
    archivedAt: null,
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

afterEach(() => vi.unstubAllGlobals());

describe("SessionRow with a workflow identity", () => {
  test("renders the worker in its own element beside the session's name", () => {
    const workflow: PwaSessionWorkflowIdentity = { runId: "run-1", unitId: "run-1/cohort/one", worker: "builder" };
    renderRow(makeSnapshot({ workflow }));

    expect(screen.getByText("builder")).toBeTruthy();
    expect(screen.getByText(SESSION_NAME)).toBeTruthy();
  });
});

test("× ends and archives a live session without purging its transcript", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  renderRow(makeSnapshot());

  expect(screen.getByRole("button", { name: "End and hide session" }).textContent).toBe("×");
  fireEvent.click(screen.getByRole("button", { name: "End and hide session" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm end and hide session" }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/sessions/sid-1?archive=true", { method: "DELETE" }));
});

test("ended sessions retain × so they can be hidden without purging", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  renderRow(makeSnapshot({ status: "ended" }));

  expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide session" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm hide session" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/sessions/sid-1?archive=true", { method: "DELETE" }));
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
});
