import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../db/test-db";
import { reviewEvents, type ReviewEventMap } from "./events";
import { freeze, unfreeze, isFrozen } from "./freeze";

let db: Database;

beforeEach(() => {
  db = openTestDb();
});

afterEach(() => {
  db.close();
});

describe("freeze rollback safety", () => {
  test("freeze inside a rolled-back transaction emits no artifact.frozen event", () => {
    const emitted: ReviewEventMap["artifact.frozen"][] = [];
    const unsub = reviewEvents.subscribe("artifact.frozen", (p) => emitted.push(p));

    try {
      try {
        db.transaction(() => {
          freeze(db, "plan", "plan-1");
          throw new Error("injected failure after freeze write");
        })();
      } catch {
        // expected rollback
      }

      expect(isFrozen(db, "plan", "plan-1")).toBe(false);
      expect(emitted).toHaveLength(0);
    } finally {
      unsub();
    }
  });

  test("unfreeze inside a rolled-back transaction emits no artifact.reopened event", () => {
    freeze(db, "plan", "plan-2");

    const emitted: ReviewEventMap["artifact.reopened"][] = [];
    const unsub = reviewEvents.subscribe("artifact.reopened", (p) => emitted.push(p));

    try {
      try {
        db.transaction(() => {
          unfreeze(db, "plan", "plan-2");
          throw new Error("injected failure after unfreeze write");
        })();
      } catch {
        // expected rollback
      }

      expect(isFrozen(db, "plan", "plan-2")).toBe(true);
      expect(emitted).toHaveLength(0);
    } finally {
      unsub();
    }
  });

  test("freeze returns payload describing the frozen artifact", () => {
    const events = freeze(db, "build_brief", "brief-1");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "artifact.frozen", payload: { target_type: "build_brief", target_id: "brief-1" } });
  });

  test("unfreeze returns payload describing the reopened artifact", () => {
    freeze(db, "build_brief", "brief-2");
    const events = unfreeze(db, "build_brief", "brief-2");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: "artifact.reopened", payload: { target_type: "build_brief", target_id: "brief-2" } });
  });

  test("freeze is a no-op and returns empty list when already frozen", () => {
    freeze(db, "plan", "plan-3");
    const events = freeze(db, "plan", "plan-3");
    expect(events).toHaveLength(0);
  });

  test("unfreeze is a no-op and returns empty list when not frozen", () => {
    const events = unfreeze(db, "plan", "plan-not-frozen");
    expect(events).toHaveLength(0);
  });
});
