import { expect, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { createScratchDatabase } from "./support/durable-database";

import type { ExecutorAdapter, ExternalExecutionReference } from "../src/domain/execution";
import type { SessionId, WorkflowRunId, RunRecordVersion } from "../src/domain/primitives";
import type { AttemptExecution, RunDecision } from "../src/domain/run-record";
import type { RunRecordRepository } from "../src/storage/repositories";
import { decodeRunDecisionStepResult, ensureAttemptSession, registerRunRecordWorkflowServices, runMachineWorkflow, type RunRecordWorkflowServices } from "../src/workflows/run-record-topology";

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
    async find_attempt_execution() { return { status: "active" }; },
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
    async find_attempt_execution() { return { status: "active" }; },
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
    async find_attempt_execution() { return { status: "active" }; },
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

for (const status of ["cancelled", "failed", "complete"] as const) {
  test(`a delayed ${status} attempt never starts or fences another session`, async () => {
    const records = {
      async find_attempt_execution() { return { status }; },
      async list_prior_sessions_to_fence() { throw new Error("must not fence replacements"); },
    } as unknown as RunRecordRepository;
    const result = await ensureAttemptSession({ records,
      find_executor: () => { throw new Error("must not start a stale attempt"); }, now: () => "2026-10-02T00:00:00Z" },
    { attempt_id: "old" } as AttemptExecution);
    expect(result).toEqual({ kind: "abandoned" });
  });
}


test("a missing run ends across the durable step boundary, including after an IO retry", async () => {
  const scratch = await createScratchDatabase("oakridge_missing_run_step_test");
  if (!scratch.ok) throw new Error(scratch.error.detail);
  const workflowIds: string[] = [];
  DBOS.setConfig({ name: "oakridge-missing-run-test", systemDatabaseUrl: scratch.value.url,
    applicationVersion: "missing-run-test", logLevel: "error" });
  try {
    await DBOS.launch();
    for (const shouldFailOnce of [false, true]) {
      let calls = 0;
      const records = { async decide_run(run_id: WorkflowRunId) {
        calls++;
        if (shouldFailOnce && calls === 1) throw new Error("temporary database outage");
        return { ok: false, error: { operation: "decide_run", run_id, kind: "run_not_found", detail: "run deleted" } };
      } } as unknown as RunRecordRepository;
      registerRunRecordWorkflowServices({ records, now: () => new Date().toISOString() } as RunRecordWorkflowServices);
      const workflowID = `missing-run-${shouldFailOnce}`;
      workflowIds.push(workflowID);
      const handle = await DBOS.startWorkflow(runMachineWorkflow, { workflowID })(
        "00000000-0000-4000-8000-000000000099" as WorkflowRunId);
      const result = await Promise.race([handle.getResult(), Bun.sleep(2500).then(() => "still_running")]);
      expect({ result, calls }).toEqual({ result: null, calls: shouldFailOnce ? 2 : 1 });
    }
  } finally {
    for (const id of workflowIds) await DBOS.cancelWorkflow(id);
    await DBOS.shutdown();
    await scratch.value.drop();
  }
}, 60_000);


test("checkpointed decisions from before Result envelopes still replay", () => {
  const decision: RunDecision = { run_id: "old-run" as WorkflowRunId, status: "complete",
    record_version: 1 as RunRecordVersion, outcome: null, transitions: [] };
  expect(decodeRunDecisionStepResult(JSON.parse(JSON.stringify(decision))))
    .toEqual({ ok: true, value: decision });
});
