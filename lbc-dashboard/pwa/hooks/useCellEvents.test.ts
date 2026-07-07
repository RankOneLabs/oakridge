/**
 * Tests for the cellStreamRetry manager — the retry/reconnect core of
 * useCellEvents. Tested directly (no React rendering) via injectable
 * fakes for EventSource, setTimeout, and clock.
 */
import { describe, expect, test } from "bun:test";

import {
  createCellStreamRetry,
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
} from "./cellStreamRetry";
import type { CellStreamRetryOptions } from "./cellStreamRetry";
import { isCellRunActiveForRetry } from "./useCellEvents";
import type { CellEvent } from "../lib/types";
import type { RunSummary } from "../lib/types";

// ---------------------------------------------------------------------------
// Fake EventSource
// ---------------------------------------------------------------------------

class FakeEventSource {
  onerror: ((ev: unknown) => void) | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  private msgListeners: Array<(ev: { data: unknown }) => void> = [];
  closed = false;

  addEventListener(type: string, fn: (ev: { data: unknown }) => void) {
    if (type === "message") this.msgListeners.push(fn);
  }

  close() {
    this.closed = true;
  }

  fireOpen() {
    this.onopen?.({});
  }

  fireError() {
    this.onerror?.({});
  }

  fireMessage(data: object) {
    const serialized = JSON.stringify(data);
    this.msgListeners.forEach((fn) => fn({ data: serialized }));
  }

  fireRawMessage(raw: string) {
    this.msgListeners.forEach((fn) => fn({ data: raw }));
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  sources: FakeEventSource[];
  retries: Array<{ fn: () => void; ms: number; cancelled: boolean }>;
  receivedEvents: CellEvent[];
  receivedErrors: string[];
  connectedCount: number;
  nowMs: number;
  runActive: boolean;
}

function makeHarness(
  overrides: Partial<CellStreamRetryOptions> = {},
): { harness: Harness; buildOpts: () => CellStreamRetryOptions } {
  const harness: Harness = {
    sources: [],
    retries: [],
    receivedEvents: [],
    receivedErrors: [],
    connectedCount: 0,
    nowMs: 0,
    runActive: true,
  };

  const buildOpts = (): CellStreamRetryOptions => ({
    url: "/api/cells/test-cell/events",
    isRunActive: () => harness.runActive,
    onEvent: (evt) => {
      harness.receivedEvents.push(evt);
    },
    onConnected: () => {
      harness.connectedCount++;
    },
    onError: (msg) => {
      harness.receivedErrors.push(msg);
    },
    createEventSource: () => {
      const es = new FakeEventSource();
      harness.sources.push(es);
      return es;
    },
    scheduleRetry: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      harness.retries.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    now: () => harness.nowMs,
    ...overrides,
  });

  return { harness, buildOpts };
}

const SAMPLE_EVENT: CellEvent = {
  ts: "2026-01-01T00:00:00Z",
  kind: "cell_started",
  payload: {},
};

function runSummary(
  cellId: string,
  status: RunSummary["status"],
): RunSummary {
  return {
    runId: `run-${cellId}`,
    run_ts: "2026-01-01T00-00-00",
    cell_id: cellId as RunSummary["cell_id"],
    task: "task" as RunSummary["task"],
    condition: { kind: "single_agent", n: 1 },
    status,
    started_ms: 0,
    exit_code: null,
    stderr_tail: "",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCellStreamRetry", () => {
  test("successful first connection delivers events without retry", () => {
    const { harness, buildOpts } = makeHarness();
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    expect(harness.sources).toHaveLength(1);

    harness.sources[0]!.fireOpen();
    expect(harness.connectedCount).toBe(1);
    expect(harness.retries).toHaveLength(0);

    harness.sources[0]!.fireMessage(SAMPLE_EVENT);
    expect(harness.receivedEvents).toHaveLength(1);
    expect(harness.receivedEvents[0]!.kind).toBe("cell_started");

    manager.stop();
  });

  test("first connection failure followed by retry success delivers events", () => {
    const { harness, buildOpts } = makeHarness();
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    // First EventSource errors (e.g. 404 before cell directory exists)
    expect(harness.sources).toHaveLength(1);
    harness.sources[0]!.fireError();

    // A retry should be scheduled with initial delay
    expect(harness.retries).toHaveLength(1);
    expect(harness.retries[0]!.ms).toBe(INITIAL_RETRY_DELAY_MS);
    expect(harness.receivedErrors).toHaveLength(0);

    // Fire the retry callback — creates second EventSource
    harness.retries[0]!.fn();
    expect(harness.sources).toHaveLength(2);

    // Second connection succeeds
    harness.sources[1]!.fireOpen();
    expect(harness.connectedCount).toBe(1);
    expect(harness.receivedErrors).toHaveLength(0);

    harness.sources[1]!.fireMessage(SAMPLE_EVENT);
    expect(harness.receivedEvents).toHaveLength(1);

    manager.stop();
  });

  test("backoff doubles each attempt up to MAX_RETRY_DELAY_MS", () => {
    const { harness, buildOpts } = makeHarness({ maxRetryMs: 60_000 });
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    for (let i = 0; i < 5; i++) {
      harness.sources.at(-1)!.fireError();
      if (i < 4) {
        harness.retries.at(-1)!.fn();
      }
    }

    expect(harness.retries).toHaveLength(5);
    const delays = harness.retries.map((r) => r.ms);
    expect(delays[0]).toBe(500);
    expect(delays[1]).toBe(1000);
    expect(delays[2]).toBe(2000);
    expect(delays[3]).toBe(MAX_RETRY_DELAY_MS);
    expect(delays[4]).toBe(MAX_RETRY_DELAY_MS);

    manager.stop();
  });

  test("successful open resets attempt counter so next error retries from min delay", () => {
    const { harness, buildOpts } = makeHarness({ maxRetryMs: 60_000 });
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    // First error → retry after 500 ms
    harness.sources[0]!.fireError();
    harness.retries[0]!.fn();

    // Second connection opens successfully → resets attempt
    harness.sources[1]!.fireOpen();

    // Then errors again → should restart backoff from 500 ms, not continue from last attempt
    harness.sources[1]!.fireError();
    expect(harness.retries).toHaveLength(2);
    expect(harness.retries[1]!.ms).toBe(INITIAL_RETRY_DELAY_MS);

    manager.stop();
  });

  test("retry timeout reports error and does not schedule further retries", () => {
    const { harness, buildOpts } = makeHarness({ maxRetryMs: 1_000 });
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    // First error — still within deadline (nowMs = 0, deadline = 1000)
    harness.sources[0]!.fireError();
    expect(harness.retries).toHaveLength(1);

    // Advance time past deadline and fire the scheduled retry
    harness.nowMs = 2_000;
    harness.retries[0]!.fn();

    // Second source immediately errors
    harness.sources[1]!.fireError();

    // Should report timeout, not schedule another retry
    expect(harness.receivedErrors).toHaveLength(1);
    expect(harness.receivedErrors[0]).toContain("timed out");
    expect(harness.retries).toHaveLength(1);

    manager.stop();
  });

  test("terminal run state stops retrying and reports error", () => {
    const { harness, buildOpts } = makeHarness();
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    // First error — run is active → retry scheduled
    harness.sources[0]!.fireError();
    expect(harness.retries).toHaveLength(1);
    expect(harness.receivedErrors).toHaveLength(0);

    // Run terminates between retries
    harness.runActive = false;

    // Fire the scheduled retry, second source errors
    harness.retries[0]!.fn();
    harness.sources[1]!.fireError();

    // Should report "no longer active", not schedule another retry
    expect(harness.receivedErrors).toHaveLength(1);
    expect(harness.receivedErrors[0]).toContain("no longer active");
    expect(harness.retries).toHaveLength(1);

    manager.stop();
  });

  test("inactive run on first error never retries", () => {
    const { harness, buildOpts } = makeHarness({ isRunActive: () => false });
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    harness.sources[0]!.fireError();

    expect(harness.retries).toHaveLength(0);
    expect(harness.receivedErrors).toHaveLength(1);
    expect(harness.receivedErrors[0]).toContain("no longer active");

    manager.stop();
  });

  test("stop() cancels the pending retry timer", () => {
    const { harness, buildOpts } = makeHarness();
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    harness.sources[0]!.fireError();
    expect(harness.retries).toHaveLength(1);
    expect(harness.retries[0]!.cancelled).toBe(false);

    manager.stop();
    expect(harness.retries[0]!.cancelled).toBe(true);
  });

  test("stop() closes the open EventSource", () => {
    const { harness, buildOpts } = makeHarness();
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    harness.sources[0]!.fireOpen();
    expect(harness.sources[0]!.closed).toBe(false);

    manager.stop();
    expect(harness.sources[0]!.closed).toBe(true);
  });

  test("events and errors after stop() are ignored", () => {
    const { harness, buildOpts } = makeHarness();
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    harness.sources[0]!.fireOpen();
    manager.stop();

    harness.sources[0]!.fireMessage(SAMPLE_EVENT);
    harness.sources[0]!.fireError();

    expect(harness.receivedEvents).toHaveLength(0);
    expect(harness.receivedErrors).toHaveLength(0);
    expect(harness.retries).toHaveLength(0);
  });

  test("stale retry callback after stop() creates no new EventSource", () => {
    let cancelFired = false;
    const { harness, buildOpts } = makeHarness({
      scheduleRetry: (fn, ms) => {
        harness.retries.push({ fn, ms, cancelled: false });
        return () => {
          cancelFired = true;
        };
      },
    });
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    harness.sources[0]!.fireError();
    manager.stop();

    expect(cancelFired).toBe(true);

    // If the cancel wasn't honoured by the timer (worst-case), the callback
    // fires anyway; stopped=true must prevent a new EventSource from opening.
    harness.retries[0]!.fn();
    expect(harness.sources).toHaveLength(1);
  });

  test("cellId change: new manager starts fresh with independent retry state", () => {
    // Simulate: user selects cell A, error fires, then user selects cell B.
    // The hook stops the old manager and creates a new one.

    const { harness: hA, buildOpts: buildOptsA } = makeHarness();
    const managerA = createCellStreamRetry(buildOptsA());
    managerA.start();

    hA.sources[0]!.fireError();
    expect(hA.retries).toHaveLength(1);

    // cellId changes — old manager is stopped
    managerA.stop();
    expect(hA.retries[0]!.cancelled).toBe(true);

    // New manager for the new cellId — completely fresh state
    const { harness: hB, buildOpts: buildOptsB } = makeHarness();
    const managerB = createCellStreamRetry(buildOptsB());
    managerB.start();

    hB.sources[0]!.fireOpen();
    hB.sources[0]!.fireMessage(SAMPLE_EVENT);

    expect(hB.receivedEvents).toHaveLength(1);
    expect(hB.receivedErrors).toHaveLength(0);
    // New manager's retry state is independent
    expect(hB.retries).toHaveLength(0);

    managerB.stop();
  });

  test("multiple events on a successful connection are all delivered", () => {
    const { harness, buildOpts } = makeHarness();
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    harness.sources[0]!.fireOpen();
    harness.sources[0]!.fireMessage({ ts: "t1", kind: "e1", payload: {} });
    harness.sources[0]!.fireMessage({ ts: "t2", kind: "e2", payload: {} });
    harness.sources[0]!.fireMessage({ ts: "t3", kind: "e3", payload: {} });

    expect(harness.receivedEvents).toHaveLength(3);
    expect(harness.receivedEvents.map((e) => e.kind)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);

    manager.stop();
  });

  test("deadline resets on successful open so a later drop can reconnect", () => {
    const { harness, buildOpts } = makeHarness({ maxRetryMs: 1_000 });
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    // Connect succeeds at t=0 — resets deadline to now+1000 = 1000
    harness.sources[0]!.fireOpen();
    expect(harness.connectedCount).toBe(1);

    // Advance time to 900 ms (within the new deadline of 1000)
    harness.nowMs = 900;

    // Connection drops; error fires
    harness.sources[0]!.fireError();

    // Should retry (within new deadline), not report timeout
    expect(harness.retries).toHaveLength(1);
    expect(harness.receivedErrors).toHaveLength(0);

    manager.stop();
  });

  test("duplicate onerror fires do not schedule multiple retries", () => {
    const { harness, buildOpts } = makeHarness();
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    // Fire onerror twice in a row before any retry timer fires
    harness.sources[0]!.fireError();
    harness.sources[0]!.fireError();
    harness.sources[0]!.fireError();

    // Only one retry should be scheduled
    expect(harness.retries).toHaveLength(1);
    expect(harness.receivedErrors).toHaveLength(0);

    manager.stop();
  });

  test("malformed JSON in message is silently dropped", () => {
    const { harness, buildOpts } = makeHarness();
    const manager = createCellStreamRetry(buildOpts());
    manager.start();

    harness.sources[0]!.fireOpen();
    harness.sources[0]!.fireRawMessage("not-valid-json{{{");
    harness.sources[0]!.fireRawMessage("");

    expect(harness.receivedEvents).toHaveLength(0);
    expect(harness.receivedErrors).toHaveLength(0);

    // Valid message after bad ones still works
    harness.sources[0]!.fireMessage(SAMPLE_EVENT);
    expect(harness.receivedEvents).toHaveLength(1);

    manager.stop();
  });
});

describe("isCellRunActiveForRetry", () => {
  test("keeps retrying before /api/runs has loaded", () => {
    expect(isCellRunActiveForRetry([], "cell-a", false)).toBe(true);
  });

  test("retries while the selected cell has a running record", () => {
    expect(
      isCellRunActiveForRetry([runSummary("cell-a", "running")], "cell-a", true),
    ).toBe(true);
  });

  test("stops retrying after loaded run state has no active selected cell", () => {
    expect(
      isCellRunActiveForRetry([runSummary("cell-a", "exited")], "cell-a", true),
    ).toBe(false);
  });
});
