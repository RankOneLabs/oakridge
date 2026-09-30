import { expect, test } from "bun:test";

import type { ExecutorAdapter, ExternalExecutionReference } from "../src/domain/execution";
import type { SessionId } from "../src/domain/primitives";
import type { AttemptExecution } from "../src/domain/run-record";
import type { RunRecordRepository } from "../src/storage/repositories";
import { ensureAttemptSession } from "../src/workflows/run-record-topology";

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
