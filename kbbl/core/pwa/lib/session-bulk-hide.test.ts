import { describe, expect, it } from "vitest";

import type { SessionSnapshot } from "../types";
import type { Sid } from "./ids";
import { selectRunHideEndedSessions, selectBulkHideActionLabel, selectBulkHideEligibleSessions, summarizeBulkHideOutcome } from "./session-bulk-hide";
import { selectSessionCloseRefusal } from "./session-close";

const session = (sid: string, status: SessionSnapshot["status"], archivedAt: string | null = null) =>
  ({ sid, status, archivedAt }) as SessionSnapshot;
const sid = (value: string) => value as Sid;

describe("session bulk hide selectors", () => {
  it("labels singular and plural actions with the confirmed count", () => {
    expect([
      selectBulkHideActionLabel(1, false),
      selectBulkHideActionLabel(7, false),
      selectBulkHideActionLabel(7, true),
    ]).toEqual(["Hide 1 ended session", "Hide 7 ended sessions", "Confirm hide 7 ended sessions"]);
  });

  it("selects only unarchived ended, fenced, and failed sessions", () => {
    const sessions = [
      session("ended", "ended"),
      session("fenced", "fenced"),
      session("failed", "failed"),
      session("provisioning", "provisioning"),
      session("idle", "idle"),
      session("prompting", "prompting"),
      session("already-archived", "ended", "2026-10-21T00:00:00Z"),
    ];
    expect(selectBulkHideEligibleSessions(sessions)).toEqual(["ended", "fenced", "failed"]);
  });

  it("keeps archived sids and each refusal in a partial-failure summary", () => {
    const held = selectSessionCloseRefusal(409, {
      error: "session belongs to run run-1 unit unit-1",
      code: "session_held_by_attempt",
      hold: {
        session_id: "e1a84fd7-0750-404b-a82c-9daefdfbdde1",
        run_id: "run-1",
        unit_id: "unit-1",
        worker: "builder",
        action_id: "f5aeeb429c1641b3",
      },
    });
    expect(summarizeBulkHideOutcome(
      [sid("ended"), sid("fenced"), sid("failed")],
      [
        { kind: "archived", sid: sid("ended") },
        { kind: "refused", sid: sid("fenced"), refusal: held },
        { kind: "refused", sid: sid("failed"), refusal: { kind: "rejected", message: "unknown session" } },
      ],
    )).toEqual({
      eligibleCount: 3,
      archivedSids: ["ended"],
      failures: [
        { sid: "fenced", refusal: held },
        { sid: "failed", refusal: { kind: "rejected", message: "unknown session" } },
      ],
    });
  });
});


it("scopes terminal unarchived snapshots to the owning run", () => {
  const owned = (id: string, status: SessionSnapshot["status"], runId: string | null, archivedAt: string | null = null): SessionSnapshot =>
    ({ ...session(id, status, archivedAt), workflow: runId ? { runId, unitId: "unit", worker: "builder" } : null });
  expect(selectRunHideEndedSessions([
    owned("ended", "ended", "run-1"), owned("fenced", "fenced", "run-1"),
    owned("failed", "failed", "run-1"), owned("idle", "idle", "run-1"),
    owned("prompting", "prompting", "run-1"), owned("archived", "ended", "run-1", "now"),
    owned("other", "ended", "run-2"), owned("standalone", "ended", null),
  ], "run-1").map((s) => s.sid)).toEqual(["ended", "fenced", "failed"]);
});
