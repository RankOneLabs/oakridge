import { expect, test } from "bun:test";

import type { ExecutorAdapter, ExternalExecutionReference } from "../src/domain/execution";
import type { AttemptExecution } from "../src/domain/run-record";
import type { RunRecordRepository } from "../src/storage/repositories";
import { ensureAttemptSession } from "../src/workflows/run-record-topology";

test("ensureAttemptSession fences a session started for an abandoned attempt", async () => {
  const reference: ExternalExecutionReference = { kind: "kbbl_session", session_id: "late-session" as never };
  const cancelled: ExternalExecutionReference[] = [];
  const adapter = {
    executor_type: "delegated_session",
    async start_or_attach() { return reference; },
    async observe_terminal() { return { kind: "pending" as const }; },
    async deliver_input() {},
    async cancel_or_fence(_attempt_id: unknown, target: ExternalExecutionReference) { cancelled.push(target); },
  } as ExecutorAdapter;
  const records = {
    async bind_session() { return { kind: "attempt_ended", status: "cancelled" } as const; },
  } as unknown as RunRecordRepository;
  const execution = { attempt_id: "00000000-0000-4000-8000-000000000001",
    session_id: "00000000-0000-4000-8000-000000000002", adapter_type: "delegated_session",
    request: { execution_id: "00000000-0000-4000-8000-000000000001" } } as unknown as AttemptExecution;
  const result = await ensureAttemptSession({ records, find_executor: () => adapter,
    now: () => "2026-09-29T01:00:00Z" }, execution);
  expect(result).toEqual({ kind: "abandoned" });
  expect(cancelled).toEqual([reference]);
});
