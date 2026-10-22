import { describe, expect, it } from "vitest";
import sample from "../__fixtures__/v2-adapter-sample.json";
import type { OperatorUnitView } from "../operator-contracts";
import { parseOakridgeRunEventFrame } from "./event";
import { parseUnitHistory, runActivityEvents } from "./activity";
import { selectRunActivity } from "../lib/run-activity";

const unit = (sample.units as unknown as OperatorUnitView[]).find((candidate) => candidate.stage === "prepare");
if (!unit) throw new Error("captured fixture lacks a prepare unit");

describe("v2 history to frozen run Activity", () => {
  it("parses v2 history and displays a published artifact from the captured run", () => {
    const history = parseUnitHistory({ unit_id: unit.unit_id, next_cursor: null,
      events: [{ id: "event-1", ingress_id: null, created_at: unit.artifacts[0].latest_revision?.created_at,
        writer: { kind: "engine" }, event: { kind: "revision_published", unit: unit.unit_id,
          artifact: unit.artifacts[0].artifact_key, body: unit.artifacts[0].latest_revision?.body } }] });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    const events = runActivityEvents(unit.run_id, [{ unit, events: history.value.events }]);
    expect(selectRunActivity(events, unit.run_id)[0]?.summary).toBe("Output published");
    expect(parseOakridgeRunEventFrame(JSON.stringify(events[0]))?.operation).toBe("slot_released");
  });

  it("maps a review decision with a numeric durable sequence", () => {
    const target = unit.artifacts[0].latest_revision?.id ?? "revision-1";
    const events = runActivityEvents(unit.run_id, [{ unit, events: [
      { id: "event-2", ingress_id: null, created_at: "2026-10-15T22:08:48.000Z", writer: { kind: "operator", subject: "test" },
        event: { kind: "operator_decided", unit: unit.unit_id, review: "artifact_gate", decision: "accept", target, payload: {} } },
    ] }]);
    expect(events.map((entry) => [entry.sequence, entry.operation])).toEqual([["1", "gate_decided"]]);
    expect(parseOakridgeRunEventFrame(JSON.stringify(events[0]))?.operation).toBe("gate_decided");
  });

  it("rejects a malformed v2 event before it reaches the Activity selector", () => {
    expect(parseUnitHistory({ unit_id: unit.unit_id, next_cursor: null,
      events: [{ id: "event-1", created_at: "2026-10-15T22:08:48.000Z",
        event: { kind: "operator_decided", review: "artifact_gate" } }] }).ok).toBe(false);
  });
});
