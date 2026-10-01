import { expect, test } from "bun:test";

import type { ExecutorAdapter, ExternalExecutionReference } from "../src/domain/execution";
import type { AttemptId, CohortId, SessionId, StageInstanceId, WorkflowRunId } from "../src/domain/primitives";
import type { AttemptExecution, CohortMachineState } from "../src/domain/run-record";
import type { RunRecordRepository } from "../src/storage/repositories";
import { ensureAttemptSession, registerRunRecordWorkflowServices, retryCohortThroughDriver,
  type CohortMachineDriver, type RunRecordWorkflowServices } from "../src/workflows/run-record-topology";

test("ensureAttemptSession fences a session started for an abandoned attempt", async () => {
  const reference: ExternalExecutionReference = { kind: "kbbl_session", session_id: "late-session" as never };
  const cancelled: ExternalExecutionReference[] = [];
  const fenced: SessionId[] = [];
  const adapter = {
    executor_type: "delegated_session",
    async start_or_attach() { return reference; },
    async observe_terminal() { return { kind: "pending" as const }; },
    async deliver_input() {},
    async cancel_or_fence(_attempt_id: unknown, target: ExternalExecutionReference) { cancelled.push(target); },
  } as ExecutorAdapter;
  const records = {
    async list_prior_sessions_to_fence() { return []; },
    async bind_session() { return { kind: "attempt_ended", status: "cancelled" } as const; },
    async mark_session_fenced(session_id: SessionId) { fenced.push(session_id); },
  } as unknown as RunRecordRepository;
  const execution = { attempt_id: "00000000-0000-4000-8000-000000000001",
    session_id: "00000000-0000-4000-8000-000000000002", adapter_type: "delegated_session",
    request: { execution_id: "00000000-0000-4000-8000-000000000001" } } as unknown as AttemptExecution;
  const result = await ensureAttemptSession({ records, find_executor: () => adapter,
    now: () => "2026-09-29T01:00:00Z" }, execution);
  expect(result).toEqual({ kind: "abandoned" });
  expect(cancelled).toEqual([reference]);
  expect(fenced).toEqual([execution.session_id]);
});

test("ensureAttemptSession does not fence an already fenced prior session", async () => {
  const calls: string[] = [];
  const adapter = {
    executor_type: "delegated_session",
    async start_or_attach() { calls.push("start"); return { kind: "kbbl_session", session_id: "new" }; },
    async cancel_or_fence() { calls.push("fence"); },
  } as unknown as ExecutorAdapter;
  const records = {
    async list_prior_sessions_to_fence() { return []; },
    async bind_session() { return { kind: "bound" }; },
  } as unknown as RunRecordRepository;
  const execution = { attempt_id: "new-attempt", cohort_id: "cohort", session_id: "new-row",
    adapter_type: "delegated_session", request: { execution_id: "new-attempt" } } as unknown as AttemptExecution;
  await ensureAttemptSession({ records, find_executor: () => adapter, now: () => "2026-09-29T01:00:00Z" }, execution);
  expect(calls).toEqual(["start"]);
});

test("ensureAttemptSession fences prior cohort sessions before starting a replacement", async () => {
  const prior: ExternalExecutionReference = { kind: "kbbl_session", session_id: "prior-session" as never };
  const replacement: ExternalExecutionReference = { kind: "kbbl_session", session_id: "replacement-session" as never };
  const calls: string[] = [];
  const adapter = {
    executor_type: "delegated_session",
    async start_or_attach() { calls.push("start replacement"); return replacement; },
    async cancel_or_fence() { calls.push("fence prior"); },
  } as unknown as ExecutorAdapter;
  const records = {
    async list_prior_sessions_to_fence() { return [{ session_id: "prior-row", attempt_id: "prior-attempt", adapter_reference: prior }]; },
    async mark_session_fenced() { calls.push("mark prior fenced"); },
    async observe_session() { calls.push("observe prior cancelled"); return { kind: "already_ended" }; },
    async bind_session() { return { kind: "bound" }; },
  } as unknown as RunRecordRepository;
  const execution = { attempt_id: "new-attempt", cohort_id: "cohort", session_id: "new-row",
    adapter_type: "delegated_session", request: { execution_id: "new-attempt" } } as unknown as AttemptExecution;
  await ensureAttemptSession({ records, find_executor: () => adapter, now: () => "2026-09-29T01:00:00Z" }, execution);
  expect(calls).toEqual(["fence prior", "mark prior fenced", "observe prior cancelled", "start replacement"]);
});

test("a concurrent retry whose launch commit finds the same key returns already_created", async () => {
  const cohort_id = "00000000-0000-4000-8000-000000000011" as CohortId;
  const attempt_id = "00000000-0000-4000-8000-000000000012" as AttemptId;
  const run_id = "00000000-0000-4000-8000-000000000013" as WorkflowRunId;
  const stage_instance_id = "00000000-0000-4000-8000-000000000014" as StageInstanceId;
  const state = { cohort_id, run_id, stage_instance_id, cohort_key: "unit", status: "blocked",
    blocked_reason: "retry", next_actor: "operator", durable_version: 4,
    latest_unfinished_attempt_id: null } as CohortMachineState;
  let claim_reads = 0;
  const records = {
    find_cohort_state: async () => state,
    find_cohort_retry_claim: async () => {
      claim_reads += 1;
      return claim_reads === 1 ? null : { attempt_id, attempt_number: 2, durable_version: 5 };
    },
    commit_cohort_launch: async () => ({ ok: true as const,
      value: { kind: "already_created" as const, attempt_id, durable_version: 5 } }),
  } as unknown as RunRecordRepository;
  const driver = { apply_event: async () => ({
    event: { change: { status: "active", blocked_reason: null, next_actor: "agent", outcome: null },
      stage_data: {}, reopen_output_names: [], effect: { kind: "none" }, launch_reason: "retry", actor: "operator" },
    launch: { attempt_number: 2, adapter_type: "delegated_session", resolve_request: async () => ({}) },
  }) } as unknown as CohortMachineDriver;
  registerRunRecordWorkflowServices({ records,
    stages: { find_by_id: async () => ({ stage_type: "test" }),
      find_contract: async () => ({ run_id, stage_key: "test", stage_contract: {} }) },
    artifacts: {}, find_run_context: async () => ({}), find_driver: () => driver,
    find_executor: () => undefined, now: () => "2026-09-30T00:00:00Z",
  } as unknown as RunRecordWorkflowServices);
  const result = await retryCohortThroughDriver({ kind: "cohort", cohort_id }, "retry-key");
  expect(result).toEqual({ kind: "already_created", run_id, cohort_id, attempt_id,
    attempt_number: 2, durable_version: 5 });
});
