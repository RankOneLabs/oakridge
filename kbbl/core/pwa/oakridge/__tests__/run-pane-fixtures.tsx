import { vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import type { SessionSnapshot } from "../../types";
import type { ArtifactDetail, ParkedGate, RunDetail } from "../types";

// Fixtures and the jsdom harness for the pane-body render tests. Not a
// `*.test.*` file, so vitest imports it rather than collecting it.

type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * jsdom has no EventSource, and the session view opens one per sid. The stub
 * records its instances so a test can assert that two panes really did open
 * two streams.
 */
export class EventSourceStub {
  static instances: EventSourceStub[] = [];
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    EventSourceStub.instances.push(this);
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = EventSourceStub.CLOSED;
  }
}

export function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const RUN: RunDetail = {
  id: "run-1",
  title: "Ship the run command center",
  repository_keys: ["oakridge"],
  workflow_name: "dev_flow_v2",
  status: "blocked",
  blocked_reason: "gate",
  next_actor: "operator",
  parked_count: 1,
  updated_at: "2026-09-01T10:00:00Z",
  stages: [
    {
      stage_instance_id: "si-build",
      name: "build",
      type: "delegated_session",
      status: "blocked",
      blocked_reason: "gate",
      next_actor: "operator",
      artifacts: [{ id: "art-build", type_id: "dev.build_result", version: 1, created_at: "2026-09-01T09:00:00Z" }],
      delegated_kbbl_sid: null,
      worktree: null,
      units: [
        { cohort_id: "c1", unit_id: "c1", sid: "sid-c1", worktree: null, status: "blocked", blocked_reason: "gate", next_actor: "operator", retryable: false, gate: "artifact_review" },
        { cohort_id: "c2", unit_id: "c2", sid: "sid-c2", worktree: null, status: "active", blocked_reason: null, next_actor: "agent", retryable: false, gate: null },
      ],
    },
  ],
};

const SESSIONS = ["c1", "c2"].map((unit, index) => ({
  work_order_id: `wo-${unit}`,
  session_id: `sid-${unit}`,
  stage_instance_id: "si-build",
  stage_key: "build",
  unit_id: unit,
  reason: "initial",
  work_order_state: "started",
  created_at: `2026-09-01T09:0${index}:00Z`,
  completed_at: null,
  executor_health_kind: null,
  cleanup_state: "pending",
}));

const GATES: ParkedGate[] = [
  {
    id: "gate-1",
    stage_instance_id: "si-build",
    gate_type: "artifact_review",
    gate_step: null,
    run_id: "run-1",
    stage_name: "build",
    unit_id: "c1",
    artifact_revision_id: "rev-1",
    worktree: null,
    resume_actions: ["approve", "reject"],
    run_state: "active",
    actionable: true,
  },
];

const ARTIFACT: ArtifactDetail = {
  id: "art-build",
  type_id: "dev.build_result",
  component_id: null,
  capabilities: { reviewable: true, commentable: true, atom_editable: false, review_items: false },
  anchor_schema: null,
  review: {
    viewer: "json",
    layout: "report",
    sections: ["summary"],
    action_labels: { approve: "Approve the build" },
  },
  run_id: "run-1",
  producing_stage: "build",
  revisions: [
    {
      id: "rev-1",
      status: "approved",
      created_at: "2026-09-01T09:00:00Z",
      body: { summary: "Two panes, one renderer" },
      validation: null,
    },
  ],
};

export const snapshotOf = (sid: string): SessionSnapshot => ({
  sid,
  name: `session ${sid}`,
  agentProfile: "claude-code",
  status: "idle",
  source: "acp",
  lastActivityTs: "2026-09-01T09:10:00Z",
  createdAt: "2026-09-01T09:00:00Z",
  artifactId: null,
  projectWorkdir: "/code/oakridge",
  worktreePath: "/code/oakridge",
  worktreeBranch: null,
  worktreeBaseRef: null,
  requestedModel: null,
  requestedEffort: null,
  endReason: null,
  fencedBy: null,
  pendingPermissionCount: 0,
  workflow: null,
});

export const makeFetch = (): FetchHandler =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // A send the operator makes from inside a pane. `InputBox` rejects any
    // body without a turn key, so answering this properly is what keeps the
    // send path on its success branch rather than its error branch.
    if (url.includes("/input")) return json({ turn_key: "turn-1", status: "accepted" });
    if (url.includes("/threads")) return json([]);
    if (url.includes("/artifact_details/")) return json(ARTIFACT);
    if (url.includes("/runs/") && url.includes("/diagnosis")) return json({
      run: RUN,
      sessions: SESSIONS.map((attempt) => ({ session_id: attempt.session_id, stage_key: attempt.stage_key,
        cohort_id: attempt.unit_id, cohort_key: attempt.unit_id, attempt_number: 1, attempt_count: 1, status: "active" })),
      current_session: { session_id: "sid-c2", stage_key: "build", cohort_id: "c2", cohort_key: "c2", attempt_number: 1, attempt_count: 1, status: "active" },
      sessions_awaiting_action: [{ session_id: "sid-c1", stage_key: "build", cohort_id: "c1", cohort_key: "c1", attempt_number: 1, attempt_count: 1, status: "blocked" }],
      active_gates: GATES.map((gate) => ({ ...gate, cohort_id: gate.unit_id })),
      pull_request_merge_waits: [],
      recent_artifacts: [{ artifact_id: "art-build", type_id: "dev.build_result", revision: 1, stage_name: "build", label: null, created_at: "2026-09-01T09:00:00Z" }],
      stage_progress: { total: 1, pending: 0, active: 0, blocked: 1, complete: 0, failed: 0, cancelled: 0 },
    });
    if (url.includes("/gates")) return json(GATES);
    if (url.includes("/runs/")) return json(RUN);
    return json([]);
  });
