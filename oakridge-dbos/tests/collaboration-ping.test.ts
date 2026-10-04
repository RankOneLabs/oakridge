import { afterAll, expect, test } from "bun:test";
import type { DBOSClient } from "@dbos-inc/dbos-sdk";

import type { DeliverSessionMessage, SessionMessage, SessionMessageRecord, SessionMessageRepository, SessionThreadId, SessionThreadMessageId } from "../src/domain/collaboration";
import type { DeliveryKey, ExecutionId, SessionMessageId, WorkflowRunId } from "../src/domain/primitives";
import { DbosCollaborationPingClient, PostgresSessionMessageRecipientResolver, PostgresSessionMessageRepository, recoverPendingSessionMessages } from "../src/runtime/collaboration-ping";
import { applyMigrations } from "../src/storage/migrate";
import { PgPostgresExecutor, type SqlExecutor } from "../src/storage/sql-executor";
import { createScratchDatabase, type ScratchDatabase } from "./support/durable-database";

const scratches: ScratchDatabase[] = [];
afterAll(async () => { for (const scratch of scratches) await scratch.drop(); });

test("an agent recipient resolves to its attached session in the same run", async () => {
  const runId = "22222222-2222-4222-8222-222222222222" as WorkflowRunId;
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const queries: unknown[][] = [];
  const sql: SqlExecutor = {
    query: async <Row extends object>(_statement: string, parameters: readonly unknown[]) => {
      queries.push([...parameters]);
      return [{ cohort_id: null, execution_id: "execution-1" as ExecutionId, executor_type: "delegated_session", adapter_reference: { kind: "kbbl_session", session_id: "session-1" } }] as unknown as readonly Row[];
    },
  };
  const resolver = new PostgresSessionMessageRecipientResolver(sql);
  const message: SessionMessage = {
    id: "11111111-1111-4111-8111-111111111111" as SessionMessageId, run_id: runId, cohort_id: null,
    sender: { kind: "agent", id: "sender" }, recipient: { kind: "agent", id: sessionId },
    thread_id: "thread-1" as SessionThreadId, message_id: "message-1" as SessionThreadMessageId,
    artifact_thread_id: null, body: "Review", delivery_key: "request-1" as DeliveryKey, created_at: "2026-09-28T12:00:00Z",
  };

  expect(await resolver.resolve(message)).toEqual({
    kind: "resolved",
    cohort_id: null,
    target: { execution_id: "execution-1" as ExecutionId, executor_type: "delegated_session", external_reference: { kind: "kbbl_session", session_id: "session-1" } },
  });
  expect(queries).toEqual([[runId, sessionId]]);
});

test("collaboration ping uses a stable DBOS workflow identity for transport retries", async () => {
  const calls: unknown[] = [];
  const dbos = { enqueuePortable: async (target: unknown, args: unknown[]) => { calls.push({ target, args }); } } as unknown as DBOSClient;
  const message: SessionMessage = {
    id: "11111111-1111-4111-8111-111111111111" as SessionMessageId,
    run_id: "22222222-2222-4222-8222-222222222222" as WorkflowRunId,
    cohort_id: null, sender: { kind: "operator", id: "operator" }, recipient: { kind: "agent", id: "worker" },
    thread_id: "thread-1" as SessionThreadId, message_id: "message-1" as SessionThreadMessageId, artifact_thread_id: null, body: "Respond to the thread",
    delivery_key: "request-1" as DeliveryKey, created_at: "2026-09-28T12:00:00Z",
  };
  const pending: SessionMessageRecord = { ...message, sender_kind: "operator", sender_id: "operator", recipient_kind: "agent", recipient_id: "worker", delivery_status: "pending", delivery_result: null, delivered_at: null };
  const messages: SessionMessageRepository = {
    put_pending: async () => ({ kind: "created", message: pending }),
    find_by_delivery_key: async () => pending,
    record_delivery_result: async () => pending,
    list_for_run: async () => [pending],
  };
  const client = new DbosCollaborationPingClient(dbos, "app-v1", messages);
  const input: DeliverSessionMessage = {
    message,
    target: { execution_id: "execution-1" as ExecutionId, executor_type: "delegated_session", external_reference: { kind: "kbbl_session", session_id: "session-1" } },
    prompt: "Respond to the thread",
  };
  const result = await client.enqueue(input);
  expect(result).toEqual({ kind: "accepted", message: pending, workflow_id: "oakridge-session-message:22222222-2222-4222-8222-222222222222:request-1" });
  expect(calls).toEqual([{ target: expect.objectContaining({ workflowName: "oakridgeCollaborationResponderWorkflow", workflowID: "oakridge-session-message:22222222-2222-4222-8222-222222222222:request-1", appVersion: "app-v1" }), args: [input] }]);
});

test("a completed durable key is readable and is not enqueued again", async () => {
  const calls: unknown[] = [];
  const dbos = { enqueuePortable: async (...args: unknown[]) => { calls.push(args); } } as unknown as DBOSClient;
  const message: SessionMessage = {
    id: "11111111-1111-4111-8111-111111111111" as SessionMessageId, run_id: "22222222-2222-4222-8222-222222222222" as WorkflowRunId,
    cohort_id: null, sender: { kind: "operator", id: "operator" }, recipient: { kind: "agent", id: "worker" }, thread_id: "thread-1" as SessionThreadId, message_id: "message-1" as SessionThreadMessageId,
    artifact_thread_id: null, body: "go", delivery_key: "request-1" as DeliveryKey, created_at: "2026-09-28T12:00:00Z",
  };
  const delivered: SessionMessageRecord = { ...message, sender_kind: "operator", sender_id: "operator", recipient_kind: "agent", recipient_id: "worker", delivery_status: "delivered", delivery_result: { kind: "delivered" }, delivered_at: "2026-09-28T12:01:00Z" };
  const messages: SessionMessageRepository = {
    put_pending: async () => ({ kind: "existing", message: delivered }), find_by_delivery_key: async () => delivered,
    record_delivery_result: async () => delivered, list_for_run: async () => [delivered],
  };
  const client = new DbosCollaborationPingClient(dbos, "app-v1", messages);
  const result = await client.enqueue({ message, target: { execution_id: "execution-1" as ExecutionId, executor_type: "delegated_session", external_reference: { kind: "kbbl_session", session_id: "session-1" } }, prompt: "go" });
  expect(result).toEqual(expect.objectContaining({ kind: "accepted", message: delivered }));
  expect(calls).toEqual([]);
});

test("a failed durable key is terminal and is not enqueued again", async () => {
  const calls: unknown[] = [];
  const dbos = { enqueuePortable: async (...args: unknown[]) => { calls.push(args); } } as unknown as DBOSClient;
  const message: SessionMessage = {
    id: "11111111-1111-4111-8111-111111111111" as SessionMessageId, run_id: "22222222-2222-4222-8222-222222222222" as WorkflowRunId,
    cohort_id: null, sender: { kind: "operator", id: "operator" }, recipient: { kind: "agent", id: "worker" },
    thread_id: "thread-1" as SessionThreadId, message_id: "message-1" as SessionThreadMessageId,
    artifact_thread_id: null, body: "go", delivery_key: "request-1" as DeliveryKey, created_at: "2026-09-28T12:00:00Z",
  };
  const failed: SessionMessageRecord = { ...message, sender_kind: "operator", sender_id: "operator", recipient_kind: "agent", recipient_id: "worker", delivery_status: "failed", delivery_result: { kind: "failed", detail: "retry limit reached" }, delivered_at: null };
  const messages: SessionMessageRepository = {
    put_pending: async () => ({ kind: "existing", message: failed }), find_by_delivery_key: async () => failed,
    record_delivery_result: async () => failed, list_for_run: async () => [failed],
  };
  const result = await new DbosCollaborationPingClient(dbos, "app-v1", messages).enqueue({ message, target: { execution_id: "execution-1" as ExecutionId, executor_type: "delegated_session", external_reference: { kind: "kbbl_session", session_id: "session-1" } }, prompt: "go" });
  expect(result).toEqual(expect.objectContaining({ kind: "accepted", message: failed }));
  expect(calls).toEqual([]);
});

test("a modeled idempotency conflict is returned without enqueueing", async () => {
  const calls: unknown[] = [];
  const dbos = { enqueuePortable: async (...args: unknown[]) => { calls.push(args); } } as unknown as DBOSClient;
  const message: SessionMessage = {
    id: "11111111-1111-4111-8111-111111111111" as SessionMessageId, run_id: "22222222-2222-4222-8222-222222222222" as WorkflowRunId,
    cohort_id: null, sender: { kind: "operator", id: "operator" }, recipient: { kind: "agent", id: "worker" },
    thread_id: "thread-1" as SessionThreadId, message_id: "message-1" as SessionThreadMessageId,
    artifact_thread_id: null, body: "go", delivery_key: "request-1" as DeliveryKey, created_at: "2026-09-28T12:00:00Z",
  };
  const messages = {
    put_pending: async () => ({ kind: "idempotency_conflict" as const, detail: "conflict" }),
    find_by_delivery_key: async () => null, record_delivery_result: async () => { throw new Error("unused"); }, list_for_run: async () => [],
  };
  const result = await new DbosCollaborationPingClient(dbos, "app-v1", messages).enqueue({ message, target: { execution_id: "execution-1" as ExecutionId, executor_type: "delegated_session", external_reference: { kind: "kbbl_session", session_id: "session-1" } }, prompt: "go" });
  expect(result).toEqual({ kind: "idempotency_conflict", detail: "conflict" });
  expect(calls).toEqual([]);
});

test("session message persistence makes delivery idempotent and readable by cohort", async () => {
  const scratch = await createScratchDatabase("oakridge_session_message_test");
  if (!scratch.ok) throw new Error(`${scratch.error.operation}: ${scratch.error.detail}`);
  scratches.push(scratch.value);
  const sql = PgPostgresExecutor.connect(scratch.value.url);
  try {
    await applyMigrations(sql);
    await sql.query(`INSERT INTO oakridge.workflow_definition (id,name,version,definition)
      VALUES ('00000000-0000-4000-8000-000000000001','messages',1,'{}')`, []);
    await sql.query(`INSERT INTO oakridge.workflow_run (id,workflow_definition_id,context,bundle_pin,status)
      VALUES ('22222222-2222-4222-8222-222222222222','00000000-0000-4000-8000-000000000001','{}',
        '{"definition_version":1,"prompt_bundle_hash":"test","adapter_version":"test","artifact_schema_version":"test"}','active')`, []);
    await sql.query(`INSERT INTO oakridge.stage_instance (id,run_id,stage_key,stage_type,stage_contract,status)
      VALUES ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','build','test','{}','active')`, []);
    await sql.query(`INSERT INTO oakridge.cohort (id,run_id,stage_instance_id,cohort_key,state,status,frozen_inputs)
      VALUES ('44444444-4444-4444-8444-444444444444','22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333','build-1','working','active','{"brief_notes":"fixture","repositories":[]}')`, []);
    await sql.query(`UPDATE oakridge.cohort SET durable_version=1
      WHERE id='44444444-4444-4444-8444-444444444444'`, []);
    await sql.query(`INSERT INTO oakridge.run_transition
      (id,run_id,owner_kind,owner_cohort_id,launch_reason,prior_owner_version,resulting_owner_version,
       event,effect_descriptor,effect_workflow_id,actor)
      VALUES ('88888888-8888-4888-8888-888888888888','22222222-2222-4222-8222-222222222222','cohort',
        '44444444-4444-4444-8444-444444444444','initial',0,1,'{"kind":"derive"}','{"kind":"none"}',
        'v15-effect:cohort:44444444-4444-4444-8444-444444444444:1','test')`, []);
    await sql.query(`INSERT INTO oakridge.attempt
      (id,run_id,stage_instance_id,cohort_id,attempt_number,status,adapter_type,request,worker)
      VALUES ('55555555-5555-4555-8555-555555555555','22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',1,'active','kbbl',
        '{"worker":"build","action":{"action_point":"initial","input":{}}}','build')`, []);
    await sql.query(`INSERT INTO oakridge.session
      (id,run_id,stage_instance_id,attempt_id,launch_transition_id,status,kbbl_session_id,adapter_reference)
      VALUES ('66666666-6666-4666-8666-666666666666','22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333','55555555-5555-4555-8555-555555555555',
        '88888888-8888-4888-8888-888888888888','active','kbbl-1',
        '{"kind":"kbbl_session","session_id":"kbbl-1"}')`, []);
    await sql.query("INSERT INTO oakridge.cohort_worker (cohort_id,worker) VALUES ('44444444-4444-4444-8444-444444444444','build')", []);
    await sql.query(`INSERT INTO oakridge.execution_intent
      (id,cohort_id,worker,attempt_id,transition_id,action_point,resolved_input,prompt,settings,status,session_id)
      VALUES ('execution-1','44444444-4444-4444-8444-444444444444','build',
        '55555555-5555-4555-8555-555555555555','88888888-8888-4888-8888-888888888888',
        'initial','{}','prompt','{}','dispatched','66666666-6666-4666-8666-666666666666')`, []);
    const repository = new PostgresSessionMessageRepository(sql);
    const message: SessionMessage = {
      id: "11111111-1111-4111-8111-111111111111" as SessionMessageId,
      run_id: "22222222-2222-4222-8222-222222222222" as WorkflowRunId,
      cohort_id: "44444444-4444-4444-8444-444444444444" as import("../src/domain/primitives").CohortId,
      sender: { kind: "agent", id: "builder" }, recipient: { kind: "agent", id: "66666666-6666-4666-8666-666666666666" },
      thread_id: "review" as SessionThreadId, message_id: "message-1" as SessionThreadMessageId, artifact_thread_id: null, body: { text: "review this" },
      delivery_key: "delivery-1" as DeliveryKey, created_at: "2026-09-28T12:00:00Z",
    };
    expect(await new PostgresSessionMessageRecipientResolver(sql).resolve(message)).toEqual({
      kind: "resolved",
      cohort_id: "44444444-4444-4444-8444-444444444444" as import("../src/domain/primitives").CohortId,
      target: { execution_id: "execution-1" as ExecutionId, executor_type: "delegated_session", external_reference: { kind: "kbbl_session", session_id: "kbbl-1" } },
    });
    expect((await repository.put_pending(message)).kind).toBe("created");
    expect((await repository.put_pending({ ...message, id: "55555555-5555-4555-8555-555555555555" as SessionMessageId, created_at: "2026-09-28T12:01:00Z" })).kind).toBe("existing");
    expect(await repository.put_pending({ ...message, id: "66666666-6666-4666-8666-666666666666" as SessionMessageId, delivery_key: "delivery-2" as DeliveryKey })).toEqual({
      kind: "idempotency_conflict", detail: "message 'review/message-1' was already submitted with a different delivery key",
    });
    let unavailable = true;
    const enqueued: DeliverSessionMessage[] = [];
    const dbos = { enqueuePortable: async (_options: unknown, args: readonly DeliverSessionMessage[]) => {
      if (unavailable) throw new Error("enqueue unavailable");
      enqueued.push(...args);
    } } as unknown as DBOSClient;
    const recipients = new PostgresSessionMessageRecipientResolver(sql);
    const pings = new DbosCollaborationPingClient(dbos, "app-v1", repository);
    const resolved = await recipients.resolve(message);
    if (resolved.kind !== "resolved") throw new Error(resolved.detail);
    await expect(pings.enqueue({ message, target: resolved.target, prompt: JSON.stringify(message.body) }))
      .rejects.toThrow("enqueue unavailable");
    unavailable = false;
    expect(await recoverPendingSessionMessages({ messages: repository, recipients, pings,
      now: () => "2026-09-28T12:02:00Z" })).toBe(1);
    expect(enqueued).toEqual([{ message: (await repository.list_pending(100))[0],
      target: resolved.target, prompt: JSON.stringify(message.body) }]);
    const delivered = await repository.record_delivery_result(message.id, { kind: "delivered" }, "2026-09-28T12:02:00Z");
    expect(delivered).toEqual(expect.objectContaining({ delivery_status: "delivered", delivery_result: { kind: "delivered" }, delivered_at: expect.any(String) }));
    expect(await repository.find_by_delivery_key(message.run_id, message.delivery_key)).toEqual(delivered);
    expect(await repository.list_for_run(message.run_id, message.cohort_id ?? undefined)).toEqual([delivered]);

    const failedMessage: SessionMessage = {
      ...message,
      id: "77777777-7777-4777-8777-777777777777" as SessionMessageId,
      thread_id: "handoff" as SessionThreadId,
      message_id: "message-2" as SessionThreadMessageId,
      delivery_key: "delivery-failed" as DeliveryKey,
    };
    expect((await repository.put_pending(failedMessage)).kind).toBe("created");
    const failed = await repository.record_delivery_result(failedMessage.id, { kind: "failed", detail: "retry limit reached" }, "2026-09-28T12:03:00Z");
    expect(failed).toEqual(expect.objectContaining({ delivery_status: "failed", delivery_result: { kind: "failed", detail: "retry limit reached" }, delivered_at: null }));
    expect(await repository.record_delivery_result(failedMessage.id, { kind: "delivered" }, "2026-09-28T12:04:00Z")).toEqual(failed);
  } finally {
    await sql.close();
  }
}, 60_000);
