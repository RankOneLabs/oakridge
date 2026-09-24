import { vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import type { SessionSnapshot } from "../../types";
import type { ArtifactDetail, ParkedGate, ReviewItem, RunDetail, RunSessionAttempt } from "../types";

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
  status: "parked",
  is_stuck: false,
  parked_count: 1,
  updated_at: "2026-09-01T10:00:00Z",
  stages: [
    {
      stage_instance_id: "si-build",
      name: "build",
      type: "delegated_session",
      status: "running",
      artifacts: [{ id: "art-build", type_id: "dev.build_result", version: 1, created_at: "2026-09-01T09:00:00Z" }],
      delegated_kbbl_sid: null,
      worktree: null,
      units: [
        { unit_id: "c1", sid: "sid-c1", worktree: null, status: "running", gate: null },
        { unit_id: "c2", sid: "sid-c2", worktree: null, status: "running", gate: null },
      ],
    },
  ],
};

const SESSIONS: RunSessionAttempt[] = ["c1", "c2"].map((unit, index) => ({
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
  capabilities: { reviewable: true, commentable: true, atom_editable: false, review_items: true },
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

const REVIEW_ITEMS: ReviewItem[] = [
  {
    id: "ri-1",
    artifact_id: "art-build",
    revision_id: "rev-1",
    anchor: "summary",
    claim: "The pane hosts the review",
    reality: "It does",
    status: "open",
    resolution: null,
    created_at: "2026-09-01T09:05:00Z",
  },
];

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
    if (url.includes("/review_items")) return json(REVIEW_ITEMS);
    if (url.includes("/threads")) return json([]);
    if (url.includes("/artifact_details/")) return json(ARTIFACT);
    if (url.includes("/gates")) return json(GATES);
    // Narrower than `/sessions`: kbbl's own per-session reads (skills, stream)
    // live under `/sessions/:sid/...` and must not be answered with the run's
    // attempt list.
    if (url.includes("/runs/") && url.includes("/sessions")) return json(SESSIONS);
    if (url.includes("/runs/")) return json(RUN);
    return json([]);
  });

