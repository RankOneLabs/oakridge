import { expect, test } from "bun:test";

import { openTestDb } from "../db/test-db";
import { AcpSessionStore } from "./store";
import { startSpecHash } from "./start-spec-hash";
import type {
  AcpSessionStartSpec,
  AcpSessionWorkflowIdentity,
  KbblSessionId,
  ResumableKey,
  TurnKey,
} from "./types";

const KEY = "exec-abc:builder" as ResumableKey;

const SPEC: AcpSessionStartSpec = {
  initial_prompt: "build it",
  workdir: "/tmp/repo",
  runtime: "fake",
};

function makeStore(): AcpSessionStore {
  return new AcpSessionStore(openTestDb());
}

function claim(
  store: AcpSessionStore,
  sid: string,
  specHash: string,
  workflow: AcpSessionWorkflowIdentity | null = null,
) {
  return store.claimResumable(KEY, {
    sid: sid as KbblSessionId,
    resumable_key: KEY,
    start_spec_hash: specHash,
    agent_profile: "fake",
    name: "test",
    artifact_id: null,
    project_workdir: "/tmp/repo",
    worktree_path: "/tmp/repo",
    requested_model: null,
    requested_effort: null,
    requested_mode: null,
    workflow,
  });
}

test("startSpecHash is stable under property order", () => {
  const reordered = {
    runtime: "fake",
    workdir: "/tmp/repo",
    initial_prompt: "build it",
  } as AcpSessionStartSpec;
  expect(startSpecHash(reordered)).toBe(startSpecHash(SPEC));
});

/**
 * Pins the digest itself, not just its stability under key order. The
 * workflow identity is deliberately excluded from `AcpSessionStartSpec` and
 * passed to `ensureResumableSession` as a separate parameter precisely so it
 * can never fold into this hash — a refactor that quietly folded it back in
 * would change `startSpecHash` for every already-claimed resumable key and
 * fail it with `session_key_conflict` on its next DBOS replay. A literal
 * value is the only assertion that would catch that.
 */
test("startSpecHash over a fixed spec is pinned to a literal digest", () => {
  expect(startSpecHash(SPEC)).toBe(
    "2cedb344d567e6b8061f9d9e7b24ca6e7f4d02b4506862a370272be49c7c16e5",
  );
});

const WORKFLOW: AcpSessionWorkflowIdentity = { run_id: "run-1", unit_id: "run-1/cohort/a", worker: "builder", pr_integration: "none" as const, pr_skill_digest: null };

test("a session claimed with an identity stores and reads it back", () => {
  const store = makeStore();
  const claimed = claim(store, "sid-1", startSpecHash(SPEC), WORKFLOW);
  expect(claimed.kind).toBe("created");
  expect(claimed.row.workflow).toEqual(WORKFLOW);
  expect(store.getSession(claimed.row.sid)?.workflow).toEqual(WORKFLOW);
});

test("a session claimed with no identity reads back null", () => {
  const store = makeStore();
  const claimed = claim(store, "sid-1", startSpecHash(SPEC));
  expect(claimed.row.workflow).toBeNull();
});

test("re-claiming an already-identified key leaves its identity untouched", () => {
  const store = makeStore();
  claim(store, "sid-1", startSpecHash(SPEC), WORKFLOW);
  const differing: AcpSessionWorkflowIdentity = { ...WORKFLOW, worker: "assessor", pr_integration: "none" as const, pr_skill_digest: null };
  const reclaimed = claim(store, "sid-2", startSpecHash(SPEC), differing);
  expect(reclaimed.kind).toBe("existing");
  expect(reclaimed.row.workflow).toEqual(WORKFLOW);
});

test("re-claiming a key with no stored identity backfills the supplied one and notifies", () => {
  const store = makeStore();
  claim(store, "sid-1", startSpecHash(SPEC));
  let notified = 0;
  store.subscribeSessionsChanged(() => { notified += 1; });
  const reclaimed = claim(store, "sid-2", startSpecHash(SPEC), WORKFLOW);
  expect(reclaimed.kind).toBe("existing");
  expect(reclaimed.row.workflow).toEqual(WORKFLOW);
  expect(notified).toBeGreaterThan(0);
});

test("claim with the same key and spec hash attaches to the existing session", () => {
  const store = makeStore();
  const hash = startSpecHash(SPEC);
  const first = claim(store, "sid-1", hash);
  const second = claim(store, "sid-2", hash);
  expect(first.kind).toBe("created");
  expect(second.kind).toBe("existing");
  expect(second.row.sid).toBe(first.row.sid);
});

test("claim with the same key but a different spec hash is a conflict", () => {
  const store = makeStore();
  claim(store, "sid-1", startSpecHash(SPEC));
  const conflict = claim(
    store,
    "sid-2",
    startSpecHash({ ...SPEC, initial_prompt: "different" }),
  );
  expect(conflict.kind).toBe("spec_conflict");
});

test("same turn key with the same payload dedupes to one row", () => {
  const store = makeStore();
  const { row } = claim(store, "sid-1", startSpecHash(SPEC));
  const input = {
    sid: row.sid,
    turn_key: "delivery-1" as TurnKey,
    source: "collaboration" as const,
    payload: "revise the plan",
  };
  const first = store.acceptTurn(input);
  const second = store.acceptTurn(input);
  expect(first.kind).toBe("created");
  expect(second.kind).toBe("existing");
  expect(store.listAcceptedTurns(row.sid)).toHaveLength(1);
});

test("same turn key with a different payload conflicts", () => {
  const store = makeStore();
  const { row } = claim(store, "sid-1", startSpecHash(SPEC));
  store.acceptTurn({
    sid: row.sid,
    turn_key: "delivery-1" as TurnKey,
    source: "collaboration",
    payload: "revise the plan",
  });
  const outcome = store.acceptTurn({
    sid: row.sid,
    turn_key: "delivery-1" as TurnKey,
    source: "collaboration",
    payload: "something else entirely",
  });
  expect(outcome.kind).toBe("payload_conflict");
});

test("accepted turns with the same timestamp retain insertion order", () => {
  const db = openTestDb();
  const store = new AcpSessionStore(db);
  const { row } = claim(store, "sid-1", startSpecHash(SPEC));
  store.acceptTurn({
    sid: row.sid,
    turn_key: "z-first" as TurnKey,
    source: "operator",
    payload: "first",
  });
  store.acceptTurn({
    sid: row.sid,
    turn_key: "a-second" as TurnKey,
    source: "operator",
    payload: "second",
  });
  db.prepare("UPDATE acp_turns SET created_at = ? WHERE sid = ?").run(
    "2026-09-02T00:00:00.000Z",
    row.sid,
  );

  expect(store.listAcceptedTurns(row.sid).map((turn) => turn.payload)).toEqual([
    "first",
    "second",
  ]);
});

test("boot sweep recovers resumable initial turns while preserving unknown follow-ups", () => {
  const store = makeStore();
  const { row } = claim(store, "sid-1", startSpecHash(SPEC));
  // A turn that may have reached an agent before the crash…
  store.acceptTurn({
    sid: row.sid,
    turn_key: "was-prompting" as TurnKey,
    source: "collaboration",
    payload: "build it",
  });
  store.markTurnPrompting(row.sid, "was-prompting" as TurnKey);
  store.setStatus(row.sid, "prompting");
  store.acceptTurn({ sid: row.sid, turn_key: "recover-initial" as TurnKey,
    source: "initial", payload: "build it" });
  store.markTurnPrompting(row.sid, "recover-initial" as TurnKey);
  // …and one that provably did not.
  store.acceptTurn({
    sid: row.sid,
    turn_key: "still-accepted" as TurnKey,
    source: "collaboration",
    payload: "queued input",
  });
  // A second session that crashed mid-provisioning.
  const provisioning = store.insertSession({
    sid: "sid-2" as KbblSessionId,
    resumable_key: null,
    start_spec_hash: null,
    agent_profile: "fake",
    name: "half-born",
    artifact_id: null,
    project_workdir: "/tmp/repo",
    worktree_path: "/tmp/repo",
    requested_model: null,
    requested_effort: null,
    requested_mode: null,
    workflow: null,
  });

  const swept = store.bootSweep();

  expect(swept.turns_marked_unknown).toBe(1);
  expect(swept.turns_retained_accepted).toBe(2);
  const wasPrompting = store.getTurn(row.sid, "was-prompting" as TurnKey);
  expect(wasPrompting?.status).toBe("unknown");
  expect(wasPrompting?.failure_code).toBe("kbbl_restart");
  expect(store.getTurn(row.sid, "still-accepted" as TurnKey)?.status).toBe(
    "accepted",
  );
  expect(store.getTurn(row.sid, "recover-initial" as TurnKey)?.status).toBe("accepted");
  expect(store.getSession(row.sid)?.status).toBe("idle");
  expect(store.getSession(provisioning.sid)?.status).toBe("failed");
  expect(store.getSession(provisioning.sid)?.end_reason).toBe("kbbl_restart");
});

test("listByArtifact reads back the stored workflow identity, not a raw undefined field", () => {
  const store = makeStore();
  const workflow: AcpSessionWorkflowIdentity = { run_id: "run-1", unit_id: "run-1/cohort/a", worker: "builder", pr_integration: "none" as const, pr_skill_digest: null };
  store.insertSession({
    sid: "sid-1" as KbblSessionId,
    resumable_key: null,
    start_spec_hash: null,
    agent_profile: "fake",
    name: "test",
    artifact_id: "artifact-1",
    project_workdir: "/tmp/repo",
    worktree_path: "/tmp/repo",
    requested_model: null,
    requested_effort: null,
    requested_mode: null,
    workflow,
  });

  const [row] = store.listByArtifact("artifact-1");
  expect(row?.workflow).toEqual(workflow);
});


test("boot recovery preserves dispatch evidence for an initial-only session", () => {
  const store = makeStore();
  const { row } = claim(store, "recovered-initial", startSpecHash(SPEC));
  const turn_key = "initial" as TurnKey;
  store.acceptTurn({ sid: row.sid, turn_key, source: "initial", payload: "build it" });
  expect(store.hasDispatchedTurns(row.sid)).toBe(false);
  store.markTurnPrompting(row.sid, turn_key);
  const started_at = store.getTurn(row.sid, turn_key)?.started_at;
  store.bootSweep();
  expect(store.getTurn(row.sid, turn_key)).toEqual(expect.objectContaining({ status: "accepted", started_at }));
  expect(store.hasDispatchedTurns(row.sid)).toBe(true);
});

test("usage writes replace atomically and absent values stay null", () => {
  const db = openTestDb();
  const store = new AcpSessionStore(db);
  claim(store, "usage", "hash");
  const sid = "usage" as KbblSessionId;
  const key = "usage-turn" as TurnKey;
  store.acceptTurn({ sid, turn_key: key, source: "operator", payload: "hi" });
  store.completeTurn(sid, key, { status: "succeeded" });
  const absent = store.usage.read(sid).turns[0]?.usage;
  expect(absent).toMatchObject({ status: "absent", input_tokens: null, output_tokens: null, model_usage: null, raw_json: null });
  store.markTurnPrompting(sid, key);
  db.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON acp_turn_usage BEGIN SELECT RAISE(ABORT, 'no usage'); END");
  expect(() => store.completeTurn(sid, key, { status: "failed" })).toThrow();
  expect(store.getTurn(sid, key)?.status).toBe("prompting");
  db.exec("DROP TRIGGER reject_usage");
  store.completeTurn(sid, key, { status: "cancelled" }, {
    status: "reported", input_tokens: 10, output_tokens: 3, cached_read_tokens: 1,
    cached_write_tokens: 2, thought_tokens: 0, total_tokens: 16, model_usage: [], raw_json: "{}",
  });
  expect(store.usage.read(sid).turns[0]?.usage).toMatchObject({ status: "reported", input_tokens: 10, total_tokens: 16 });
  expect(db.query("SELECT * FROM acp_turn_usage").all()).toHaveLength(1);
  db.close();
});

test("restart deletes requeued initial usage and records interrupted operator usage", () => {
  const store = makeStore();
  claim(store, "recovery", "hash");
  const sid = "recovery" as KbblSessionId;
  for (const source of ["initial", "operator"] as const) {
    const key = source as TurnKey;
    store.acceptTurn({ sid, turn_key: key, source, payload: "hi" });
    store.completeTurn(sid, key, { status: "unknown" });
    store.markTurnPrompting(sid, key);
  }
  store.setStatus(sid, "prompting");
  store.bootSweep();
  expect(store.usage.read(sid).turns.map(t => [t.status, t.usage?.status ?? null])).toEqual([
    ["accepted", null], ["unknown", "absent"],
  ]);
  store.completeTurn(sid, "initial" as TurnKey, { status: "succeeded" });
  expect(store.usage.read(sid).turns.every(t => t.usage !== null)).toBe(true);
});

test("reading snapshots persist raw costs and process segments across store recreation", () => {
  const db = openTestDb();
  const store = new AcpSessionStore(db);
  claim(store, "reading", "hash");
  const sid = "reading" as KbblSessionId;
  expect(store.usage.nextProcessSeq(sid)).toBe(0);
  const reading = { sid, process_seq: 0, context_used: 20, context_size: 100, cost_amount: 5, cost_currency: "USD", active_turn_key: null, autonomous: false, origin_kind: null };
  store.usage.appendReading(reading);
  const reopened = new AcpSessionStore(db);
  expect(reopened.usage.nextProcessSeq(sid)).toBe(1);
  reopened.usage.appendReading({ ...reading, process_seq: 1, cost_amount: 8 });
  expect(reopened.usage.read(sid).readings.map(r => [r.seq, r.process_seq, r.cost_amount, r.active_turn_key])).toEqual([[0, 0, 5, null], [1, 1, 8, null]]);
  db.close();
});
