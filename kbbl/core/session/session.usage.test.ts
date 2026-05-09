import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Session,
  USAGE_OBSERVATION_BUFFER_CAPACITY,
  type EnvelopeEvent,
  type UsageObservation,
} from "./session";

let sessionsDir: string;
let session: Session;

function makeSession(): Session {
  return new Session({
    oakridgeSid: "test-sid",
    workdir: "/tmp",
    name: "test",
    sessionsDir,
  });
}

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "kbbl-usage-test-"));
  session = makeSession();
});

afterEach(async () => {
  await session.abort();
  rmSync(sessionsDir, { recursive: true, force: true });
});

describe("Session.observeTurnEnd", () => {
  test("appends a UsageObservation to the ring buffer with all fields populated", async () => {
    await session.observeTurnEnd({
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
      },
      model: "claude-opus-4-7",
    });

    const obs = session.getUsageObservations();
    expect(obs.length).toBe(1);
    const o = obs[0]!;
    expect(o.turn_seq).toBe(1);
    expect(o.input_tokens).toBe(10);
    expect(o.output_tokens).toBe(5);
    expect(o.cache_creation_input_tokens).toBe(100);
    expect(o.cache_read_input_tokens).toBe(200);
    expect(o.model).toBe("claude-opus-4-7");
    expect(o.seconds_since_prev_turn).toBeGreaterThanOrEqual(0);
  });

  test("defaults missing cache token fields to 0", async () => {
    await session.observeTurnEnd({
      usage: { input_tokens: 1, output_tokens: 1 },
      model: null,
    });

    const o = session.getUsageObservations()[0]!;
    expect(o.cache_creation_input_tokens).toBe(0);
    expect(o.cache_read_input_tokens).toBe(0);
    expect(o.model).toBeNull();
  });

  test("turn_seq increments monotonically across calls", async () => {
    for (let i = 0; i < 5; i++) {
      await session.observeTurnEnd({
        usage: { input_tokens: 1, output_tokens: 1 },
        model: null,
      });
    }
    const seqs = session.getUsageObservations().map((o) => o.turn_seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  test("ring buffer caps at USAGE_OBSERVATION_BUFFER_CAPACITY, dropping oldest", async () => {
    const overshoot = 50;
    const total = USAGE_OBSERVATION_BUFFER_CAPACITY + overshoot;
    for (let i = 0; i < total; i++) {
      await session.observeTurnEnd({
        usage: { input_tokens: i, output_tokens: i },
        model: null,
      });
    }

    const obs = session.getUsageObservations();
    expect(obs.length).toBe(USAGE_OBSERVATION_BUFFER_CAPACITY);
    expect(obs[0]!.turn_seq).toBe(overshoot + 1);
    expect(obs[obs.length - 1]!.turn_seq).toBe(total);
  });

  test("seconds_since_prev_turn measures the gap between successive turns", async () => {
    await session.observeTurnEnd({
      usage: { input_tokens: 1, output_tokens: 1 },
      model: null,
    });
    await new Promise((r) => setTimeout(r, 30));
    await session.observeTurnEnd({
      usage: { input_tokens: 1, output_tokens: 1 },
      model: null,
    });

    const obs = session.getUsageObservations();
    expect(obs[1]!.seconds_since_prev_turn).toBeGreaterThanOrEqual(0.02);
    expect(obs[1]!.seconds_since_prev_turn).toBeLessThan(2);
  });

  test("emits a usage_observation envelope event whose payload matches the observation", async () => {
    const events: EnvelopeEvent[] = [];
    session.subscribe((e) => events.push(e));

    await session.observeTurnEnd({
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_read_input_tokens: 42,
      },
      model: "claude-haiku-4-5",
    });

    const usageEvents = events.filter((e) => e.type === "usage_observation");
    expect(usageEvents.length).toBe(1);

    const payload = usageEvents[0]!.payload as UsageObservation;
    const obs = session.getUsageObservations()[0]!;
    expect(payload).toEqual(obs);
    expect(payload.input_tokens).toBe(7);
    expect(payload.cache_read_input_tokens).toBe(42);
    expect(payload.cache_creation_input_tokens).toBe(0);
    expect(payload.model).toBe("claude-haiku-4-5");
  });

  test("getUsageObservations returns a defensive copy of the array", async () => {
    await session.observeTurnEnd({
      usage: { input_tokens: 1, output_tokens: 1 },
      model: null,
    });

    const snapshot = session.getUsageObservations();
    snapshot.length = 0;
    expect(session.getUsageObservations().length).toBe(1);
  });

  test("getUsageObservations returns deep copies; mutating a returned item does not affect the buffer", async () => {
    await session.observeTurnEnd({
      usage: { input_tokens: 5, output_tokens: 7 },
      model: "claude-opus-4-7",
    });

    const snapshot = session.getUsageObservations();
    snapshot[0]!.input_tokens = 999;
    snapshot[0]!.model = "tampered";

    const fresh = session.getUsageObservations();
    expect(fresh[0]!.input_tokens).toBe(5);
    expect(fresh[0]!.model).toBe("claude-opus-4-7");
  });
});
