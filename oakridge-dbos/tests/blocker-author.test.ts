import { expect, test } from "bun:test";
import type { ActionId } from "../src/domain/primitives";
import { selectRevisionAuthor } from "../src/projections/unit-view";
import type { AttemptRecord } from "../src/storage/schema-records";

const action = "action-writer" as ActionId;
function attempt(seq: number, created_at: string, session: string | null): AttemptRecord {
  return { action_id: action, seq, created_at: new Date(created_at), kbbl_session_id: session, worker: "writer", unit_id: "run/briefs/c1",
    run_id: "run-1", mode: { kind: "initial" }, cause: { kind: "missing" }, status: { kind: "started" }, publication_secret_hash: null } as unknown as AttemptRecord;
}

test("a blocker revision's author is the exact stored attempt", () => {
  const attempts = [attempt(1, "2026-11-17T10:00:00Z", "s-1"), attempt(2, "2026-11-17T11:00:00Z", "s-2"), attempt(3, "2026-11-17T13:00:00Z", "s-3")];
  expect(selectRevisionAuthor(attempts, { by_action_id: action, by_seq: 2 }))
    .toEqual({ worker: "writer", action_id: action, attempt_seq: 2, session_id: "s-2" });
});

test("an operator edit has no author", () => {
  expect(selectRevisionAuthor([attempt(1, "2026-11-17T10:00:00Z", "s-1")], { by_action_id: null, by_seq: null })).toBeNull();
});

test("a revision whose action has no recorded attempt has no author", () => {
  expect(selectRevisionAuthor([], { by_action_id: action, by_seq: 2 })).toBeNull();
});
