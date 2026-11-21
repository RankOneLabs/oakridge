import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { RunSummary, RunDetail, RepositoryKey, CohortId, StageUnitParams } from "../run-types";
import type { ParkedGate } from "../artifact-types";
import type { BuildBrief } from "../lib/build-brief";

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
}

interface RunViewSeed {
  readonly detail: RunDetail | null;
  readonly gates?: ParkedGate[];
  readonly runs?: RunSummary[] | null;
}

export function renderRunView(ui: ReactElement, { detail, gates = [], runs }: RunViewSeed) {
  const client = makeClient();
  if (runs) client.setQueryData(["oakridge", "runs", ""], runs);
  if (detail) {
    client.setQueryData(["oakridge", "run", detail.id], detail);
    client.setQueryData(["oakridge", "run", detail.id, "gates"], gates);
    client.setQueryData(["oakridge", "run", detail.id, "sessions"], []);
  }
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A stage unit's `params` is the minted fan-out item (`{unit_id, artifact}`)
 * — a build unit's `artifact` is a `dev.build_brief` body. Fixtures build a
 * full valid BuildBrief rather than the flat ad hoc shape this replaced, so
 * `selectCohortBrief`'s `isBuildBrief` guard accepts them the way it accepts
 * a real one.
 */
export function buildBriefParams(overrides: Partial<Extract<BuildBrief, { shape: "legacy" }>> = {}): StageUnitParams {
  const artifact: BuildBrief = {
    shape: "legacy",
    cohort_id: "cohort-a" as CohortId,
    repository_key: "oakridge" as RepositoryKey,
    title: "Untitled cohort",
    depends_on: [],
    goal: "",
    files_in_scope: [],
    decisions_made: [],
    approaches_rejected: [],
    acceptance_criteria: [],
    next_action: "",
    ...overrides,
  };
  return { unit_id: artifact.cohort_id, artifact };
}

export const RUN_DETAIL_FIXTURE: RunDetail = {
  id: "run-1",
  title: "Ship the operator console",
  repository_keys: ["oakridge"],
  workflow_name: "v2_spec_to_ship",
  status: "running",
  is_stuck: false,
  stages: [
    {
      stage_instance_id: "si-1",
      name: "spec",
      type: "spec_generation",
      status: "complete",
      artifacts: [{ id: "art-spec-1", type_id: "spec_v2", version: 1 }],
      delegated_kbbl_sid: null,
      worktree: null,
    },
    {
      stage_instance_id: "si-2",
      name: "build",
      type: "build_agent",
      status: "running",
      artifacts: [{ id: "art-build-1", type_id: "build_output", version: 1 }],
      delegated_kbbl_sid: "aaaabbbbccccdddd",
      worktree: {
        branch: "cohort/v2_readiness/3-minimum_v2",
        path: "/code/oakridge",
        base_ref: "epic/v2_readiness",
      },
    },
  ],
  parked_count: 0,
  updated_at: "2026-07-01T10:00:00Z",
};
