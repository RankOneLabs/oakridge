import { expect, test } from "bun:test";

import { openTestDb } from "../db/test-db";
import { AcpSessionStore, startSpecHash } from "./store";
import type {
  AcpSessionStartSpec,
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

function claim(store: AcpSessionStore, sid: string, specHash: string) {
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

test("boot sweep fails prompting turns, retains accepted turns, and settles session statuses", () => {
  const store = makeStore();
  const { row } = claim(store, "sid-1", startSpecHash(SPEC));
  // A turn that may have reached an agent before the crash…
  store.acceptTurn({
    sid: row.sid,
    turn_key: "was-prompting" as TurnKey,
    source: "initial",
    payload: "build it",
  });
  store.markTurnPrompting(row.sid, "was-prompting" as TurnKey);
  store.setStatus(row.sid, "prompting");
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
  });

  const swept = store.bootSweep();

  expect(swept.turns_marked_unknown).toBe(1);
  expect(swept.turns_retained_accepted).toBe(1);
  const wasPrompting = store.getTurn(row.sid, "was-prompting" as TurnKey);
  expect(wasPrompting?.status).toBe("unknown");
  expect(wasPrompting?.failure_code).toBe("kbbl_restart");
  expect(store.getTurn(row.sid, "still-accepted" as TurnKey)?.status).toBe(
    "accepted",
  );
  expect(store.getSession(row.sid)?.status).toBe("idle");
  expect(store.getSession(provisioning.sid)?.status).toBe("failed");
  expect(store.getSession(provisioning.sid)?.end_reason).toBe("kbbl_restart");
});
