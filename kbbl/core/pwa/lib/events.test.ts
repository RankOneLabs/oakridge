import { describe, expect, it } from "vitest";

import { computeMetrics } from "./events";
import type { EnvelopeEvent } from "../types";

function resultEvent(
  id: number,
  payload: {
    total_cost_usd: number;
    duration_ms?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  },
): EnvelopeEvent {
  return {
    id,
    type: "result",
    ts: "2026-05-23T00:00:00Z",
    payload,
  } as unknown as EnvelopeEvent;
}

describe("computeMetrics", () => {
  it("treats a single result event's total_cost_usd as both session total and last-turn cost", () => {
    const m = computeMetrics([resultEvent(1, { total_cost_usd: 0.5 })]);
    expect(m.totalCost).toBe(0.5);
    expect(m.last?.cost).toBe(0.5);
  });

  it("uses the latest cumulative value as totalCost (not the sum) and exposes the per-turn delta on m.last.cost", () => {
    const events = [
      resultEvent(1, { total_cost_usd: 0.5 }),
      resultEvent(2, { total_cost_usd: 1.2 }),
      resultEvent(3, { total_cost_usd: 1.5 }),
    ];
    const m = computeMetrics(events);
    expect(m.totalCost).toBeCloseTo(1.5, 10);
    expect(m.last?.cost).toBeCloseTo(0.3, 10);
  });

  it("returns zeroed metrics when there are no result events", () => {
    const m = computeMetrics([]);
    expect(m.totalCost).toBe(0);
    expect(m.last).toBeNull();
  });
});
