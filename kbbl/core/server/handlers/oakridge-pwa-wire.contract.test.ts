import { expect, test } from "bun:test";

import { createConfigurationApp, type ConfigurationHttpDependencies } from "../../../../oakridge-dbos/src/http/configuration";
import { createOperatorProjectionApp } from "../../../../oakridge-dbos/src/http/operator-projections";
import { projectRunEvent, type RunEventRow } from "../../../../oakridge-dbos/src/domain/run-event";
import type { OperatorProjectionRepository } from "../../../../oakridge-dbos/src/storage/postgres-operators";
import { parseOakridgeRunEventFrame, parseProject } from "../../pwa/oakridge/wire";

const RUN_ID = "10000000-0000-0000-0000-000000000001";

const effectDescriptors = [
  { kind: "none" },
  { kind: "deliver_message" },
  { kind: "resume_wait" },
  { kind: "start_stage", stage_instance_id: "stage-1" },
  { kind: "start_attempt", cohort_id: "cohort-1", attempt_number: 1 },
  { kind: "dev_flow_build_cohort_transition", event: { kind: "builder_attempt_lost" }, disposition: "transitioned" },
  { kind: "pull_request_observed", repository_key: "oakridge", pull_request_url: "https://example.test/pr/1", state: "open", source: "poll", merged_at: null },
  { kind: "pull_request_merge_confirmed", repository_key: "oakridge", pull_request_url: "https://example.test/pr/1", state: "merged", source: "operator", merged_at: "2026-09-29T00:00:00Z" },
  { kind: "future_effect" },
] as const;

const rowFor = (effect_descriptor: RunEventRow["effect_descriptor"], index: number): RunEventRow => ({
  sequence: String(index + 1), id: "20000000-0000-0000-0000-000000000001", run_id: RUN_ID,
  owner_kind: "run", owner_run_id: RUN_ID, owner_stage_instance_id: null, owner_cohort_id: null,
  launch_reason: "initial", prior_owner_version: String(index), resulting_owner_version: String(index + 1),
  effect_descriptor, effect_workflow_id: `effect-${index}`, actor: "core", created_at: "2026-09-29T00:00:00Z",
});

test("every effect kind projected by projectRunEvent parses as a PWA frame", async () => {
  const events = effectDescriptors.map((descriptor, index) => projectRunEvent(rowFor(descriptor, index)));
  const repository = { list_run_events: async () => events } as unknown as OperatorProjectionRepository;
  const app = createOperatorProjectionApp(repository);
  const response = await app.request(`/run_events?run_id=${RUN_ID}`);
  expect(response.status).toBe(200);
  const wire: unknown = await response.json();
  if (!Array.isArray(wire)) throw new Error("run events response is not an array");
  for (const value of wire) {
    expect(parseOakridgeRunEventFrame(JSON.stringify({ ...value, replayed: false }))).not.toBeNull();
  }
});

test("GET /projects parses the server's integration branch", async () => {
  const project = { id: RUN_ID, name: "oakridge", repo_dir: "/workspace/oakridge", created_at: "2026-09-29T00:00:00Z", forge_repository: null, integration_branch: "main" };
  const dependencies = { projects: { list: async () => [project] } } as unknown as ConfigurationHttpDependencies;
  const response = await createConfigurationApp(dependencies).request("/projects");
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("projects response is not an array");
  const parsed = parseProject(body[0]);
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.value.base_branch).toBe("main");
});
