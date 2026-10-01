import { expect, test } from "bun:test";

import { createConfigurationApp, type ConfigurationHttpDependencies } from "../../../../oakridge-dbos/src/http/configuration";
import { createOperatorProjectionApp } from "../../../../oakridge-dbos/src/http/operator-projections";
import { createCollaborationApp, type CollaborationHttpDependencies } from "../../../../oakridge-dbos/src/http/collaboration";
import { projectRunEvent, type RunEventRow } from "../../../../oakridge-dbos/src/domain/run-event";
import type { SessionMessageRecord } from "../../../../oakridge-dbos/src/domain/collaboration";
import type { CohortId } from "../../../../oakridge-dbos/src/domain/primitives";
import { createDevFlowAdapterRegistry } from "../../../../oakridge-dbos/src/adapters/dev-flow";
import { PostgresOperatorProjectionRepository } from "../../../../oakridge-dbos/src/storage/postgres-operators";
import type { OperatorProjectionRepository } from "../../../../oakridge-dbos/src/storage/postgres-operators";
import { DiagnosisSql, stage } from "../../../../oakridge-dbos/tests/support/operator-sql-stub";
import { parseRunEventFrame, parseProject, parseRunDiagnosis, parseSessionMessageAccepted, parseSessionMessageRecord } from "../../pwa/oakridge/wire";

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
  expect(wire.map((value) => parseRunEventFrame({ ...value, replayed: false }).effect.kind))
    .toEqual(effectDescriptors.map((descriptor) => descriptor.kind === "future_effect" ? "unrecognized" : descriptor.kind));
});

test("a malformed known effect names its bad field while future effects remain visible", () => {
  const malformed = projectRunEvent(rowFor({ kind: "start_attempt", cohort_id: "cohort-1", attempt_number: "wrong" }, 9));
  expect(() => parseRunEventFrame({ ...malformed, replayed: false })).toThrow("effect.attempt_number");
  const future = projectRunEvent(rowFor({ kind: "future_effect" }, 10));
  expect(parseRunEventFrame({ ...future, replayed: false }).effect).toEqual({ kind: "unrecognized", effect_kind: "future_effect" });
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
  if (parsed.ok) expect(parsed.value.integration_branch).toBe("main");
});

test("diagnosis from PostgresOperatorProjectionRepository parses", async () => {
  const repository = new PostgresOperatorProjectionRepository(
    new DiagnosisSql({ stages: [stage(1, "active")] }), "test-app-version", createDevFlowAdapterRegistry(),
  );
  const response = await createOperatorProjectionApp(repository).request(`/runs/${RUN_ID}/diagnosis`);
  expect(response.status).toBe(200);
  expect(parseRunDiagnosis(await response.json()).run.id).toBe(RUN_ID);
});

test("session message routes serialize records accepted by PWA guards", async () => {
  const stored: SessionMessageRecord[] = [];
  const cohort_id = "30000000-0000-0000-0000-000000000001" as CohortId;
  const dependencies = {
    messages: {
      list_for_run: async () => stored,
      find_by_delivery_key: async () => stored[0] ?? null,
    },
    message_recipients: { resolve: async () => ({ kind: "resolved", cohort_id, target: {
      execution_id: "execution-1", executor_type: "delegated_session", external_reference: { kind: "kbbl_session", session_id: "kbbl-1" },
    } }) },
    send_message: async ({ message }: { message: SessionMessageRecord }) => {
      const record = { ...message, sender_kind: message.sender.kind, sender_id: message.sender.id,
        recipient_kind: message.recipient.kind, recipient_id: message.recipient.id,
        delivery_status: "pending" as const, delivery_result: null, delivered_at: null } as SessionMessageRecord;
      stored.push(record);
      return { kind: "accepted", message: record, workflow_id: "message-1" };
    },
    new_id: () => "40000000-0000-0000-0000-000000000001",
    now: () => "2026-09-29T00:00:00Z",
  } as unknown as CollaborationHttpDependencies;
  const app = createCollaborationApp(dependencies);
  const posted = await app.request(`/runs/${RUN_ID}/messages`, { method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "message-1" },
    body: JSON.stringify({ sender: { kind: "agent", id: "untrusted" }, cohort_id: RUN_ID,
      recipient: { kind: "agent", id: "session-1" }, thread_id: "thread-1", body: "review" }),
  });
  expect(posted.status).toBe(202);
  const accepted = parseSessionMessageAccepted(await posted.json());
  expect(accepted.message.sender).toEqual({ kind: "operator", id: "operator" });
  expect(accepted.message.cohort_id).toBe(cohort_id);
  const listed = await app.request(`/runs/${RUN_ID}/messages`);
  expect((await listed.json() as unknown[]).map(parseSessionMessageRecord)).toHaveLength(1);
  const delivery = await app.request(`/runs/${RUN_ID}/messages/message-1`);
  expect(parseSessionMessageRecord(await delivery.json()).delivery_status).toBe("pending");
});
