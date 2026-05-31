import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunSpec } from "./contracts";
import { conditionName } from "./contracts";
import { formatRunTs, RunRegistry, type Launcher } from "./runs";
import { cellIdFor, parseCellId } from "./store";
import { createApp } from "../server";

// ---------------------------------------------------------------------------
// Stub launcher — no Python process spawned
// ---------------------------------------------------------------------------

function makeStub(exitCode: number): {
  launcher: Launcher;
  resolve: () => void;
} {
  let resolve!: () => void;
  const done = new Promise<{ code: number; stderrTail: string }>((res) => {
    resolve = () =>
      res({
        code: exitCode,
        stderrTail: exitCode === 0 ? "" : "subprocess failed",
      });
  });
  const launcher: Launcher = {
    spawn(_args, _opts) {
      return { pid: 99999, kill: () => {}, done };
    },
  };
  return { launcher, resolve };
}

const BASE_SPEC: RunSpec = {
  task: "prose_substrate_thesis",
  model_pool: ["claude-opus-4-7"],
  condition: { kind: "single_agent", n: 1 },
  grade: true,
};

const RUN_TS = "2026-05-29T14-32-07-456000Z";

// ---------------------------------------------------------------------------
// formatRunTs
// ---------------------------------------------------------------------------

describe("formatRunTs", () => {
  test("produces the exact Python strftime('%Y-%m-%dT%H-%M-%S-%fZ') shape", () => {
    const d = new Date("2026-05-29T14:32:07.456Z");
    expect(formatRunTs(d)).toBe("2026-05-29T14-32-07-456000Z");
  });

  test("zero-pads all components", () => {
    const d = new Date("2026-01-02T03:04:05.006Z");
    expect(formatRunTs(d)).toBe("2026-01-02T03-04-05-006000Z");
  });

  test("microsecond field is always 6 digits with trailing zeros", () => {
    // 100ms → '100000', 050ms → '050000'
    expect(formatRunTs(new Date("2026-06-01T00:00:00.100Z"))).toBe(
      "2026-06-01T00-00-00-100000Z",
    );
    expect(formatRunTs(new Date("2026-06-01T00:00:00.050Z"))).toBe(
      "2026-06-01T00-00-00-050000Z",
    );
  });
});

// ---------------------------------------------------------------------------
// RunRegistry lifecycle
// ---------------------------------------------------------------------------

describe("RunRegistry", () => {
  test("running -> exited when done resolves with code 0", async () => {
    const { launcher, resolve } = makeStub(0);
    const registry = new RunRegistry(launcher);

    const record = registry.launch({
      runTs: RUN_TS,
      spec: BASE_SPEC,
      specPath: "/tmp/spec.json",
      outputDir: "/tmp/output",
    });

    expect(record.status).toBe("running");

    resolve();
    await new Promise<void>((r) => setTimeout(r, 0));

    const updated = registry.get(RUN_TS)!;
    expect(updated.status).toBe("exited");
    expect(updated.exit_code).toBe(0);
    expect(updated.stderr_tail).toBe("");
  });

  test("running -> failed when done resolves with code !== 0", async () => {
    const { launcher, resolve } = makeStub(1);
    const registry = new RunRegistry(launcher);
    const runTs = "2026-05-29T15-00-00-000000Z";

    registry.launch({
      runTs,
      spec: BASE_SPEC,
      specPath: "/tmp/spec.json",
      outputDir: "/tmp/output",
    });

    resolve();
    await new Promise<void>((r) => setTimeout(r, 0));

    const updated = registry.get(runTs)!;
    expect(updated.status).toBe("failed");
    expect(updated.exit_code).toBe(1);
    expect(updated.stderr_tail).toBe("subprocess failed");
  });

  test("cancel marks record as failed and returns true", () => {
    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);
    const runTs = "2026-05-29T16-00-00-000000Z";

    registry.launch({
      runTs,
      spec: BASE_SPEC,
      specPath: "/tmp/spec.json",
      outputDir: "/tmp/output",
    });

    expect(registry.get(runTs)!.status).toBe("running");
    const result = registry.cancel(runTs);
    expect(result).toBe(true);
    expect(registry.get(runTs)!.status).toBe("failed");
  });

  test("cancel preserves exit_code/stderr_tail once the killed process exits", async () => {
    const { launcher, resolve } = makeStub(143);
    const registry = new RunRegistry(launcher);
    const runTs = "2026-05-29T17-00-00-000000Z";

    registry.launch({
      runTs,
      spec: BASE_SPEC,
      specPath: "/tmp/spec.json",
      outputDir: "/tmp/output",
    });

    registry.cancel(runTs);
    expect(registry.get(runTs)!.status).toBe("failed");

    // The killed subprocess exits; the done handler must still record the
    // real exit code + stderr tail without clobbering the cancelled status.
    resolve();
    await new Promise<void>((r) => setTimeout(r, 0));

    const updated = registry.get(runTs)!;
    expect(updated.status).toBe("failed");
    expect(updated.exit_code).toBe(143);
    expect(updated.stderr_tail).toBe("subprocess failed");
  });

  test("cancel returns false for an unknown runId", () => {
    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);
    expect(registry.cancel("no-such-run")).toBe(false);
  });

  test("cell_id round-trips through parseCellId with canonical n-suffixed condition", () => {
    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);
    const runTs = "2026-05-29T17-00-00-000000Z";
    const spec: RunSpec = {
      task: "prose_substrate_thesis",
      model_pool: ["claude-opus-4-7"],
      condition: { kind: "ensemble_multi_round", n: 3 },
      grade: true,
    };

    const record = registry.launch({
      runTs,
      spec,
      specPath: "/tmp/spec.json",
      outputDir: "/tmp/output",
    });

    expect(record.cell_id).toBe(
      cellIdFor(runTs, spec.task, "ensemble_multi_round_n3"),
    );

    const parsed = parseCellId(record.cell_id);
    expect(parsed).not.toBeNull();
    expect(parsed!.runTs).toBe(runTs);
    expect(parsed!.target).toBe("prose_substrate_thesis");
    // conditionName("ensemble_multi_round", 3) === "ensemble_multi_round_n3"
    expect(parsed!.condition).toBe("ensemble_multi_round_n3");
  });

  test("cell_id single_agent has no n-suffix", () => {
    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);
    const runTs = "2026-05-29T18-00-00-000000Z";

    const record = registry.launch({
      runTs,
      spec: BASE_SPEC,
      specPath: "/tmp/spec.json",
      outputDir: "/tmp/output",
    });

    const parsed = parseCellId(record.cell_id);
    expect(parsed).not.toBeNull();
    expect(parsed!.condition).toBe("single_agent");
  });

  test("list returns most-recent-first by started_ms", async () => {
    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);

    registry.launch({
      runTs: "2026-05-29T10-00-00-000000Z",
      spec: BASE_SPEC,
      specPath: "/tmp/spec1.json",
      outputDir: "/tmp/out1",
    });
    await new Promise<void>((r) => setTimeout(r, 2));
    registry.launch({
      runTs: "2026-05-29T11-00-00-000000Z",
      spec: BASE_SPEC,
      specPath: "/tmp/spec2.json",
      outputDir: "/tmp/out2",
    });

    const summaries = registry.list();
    expect(summaries).toHaveLength(2);
    expect(summaries[0].runId).toBe("2026-05-29T11-00-00-000000Z");
    expect(summaries[1].runId).toBe("2026-05-29T10-00-00-000000Z");
  });

  test("toSummary produces the exact RunSummary fields", () => {
    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);
    const runTs = "2026-05-29T19-00-00-000000Z";

    const record = registry.launch({
      runTs,
      spec: BASE_SPEC,
      specPath: "/tmp/spec.json",
      outputDir: "/tmp/output",
    });

    const summary = registry.toSummary(record);
    expect(summary.runId).toBe(runTs);
    expect(summary.run_ts).toBe(runTs);
    expect(summary.task).toBe(BASE_SPEC.task);
    expect(summary.condition).toEqual(BASE_SPEC.condition);
    expect(summary.status).toBe("running");
    expect(summary.exit_code).toBeNull();
    expect(summary.stderr_tail).toBe("");
    expect(typeof summary.started_ms).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// HTTP routes /api/runs via createApp({ registry })
// ---------------------------------------------------------------------------

// Provider key env vars saved/restored around each test so the no-key
// warning test doesn't leak into neighbors.
const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"] as const;

describe("HTTP /api/runs", () => {
  let testRunRoot: string;
  let savedKeys: Record<string, string | undefined>;
  let savedRunRoot: string | undefined;

  beforeEach(async () => {
    testRunRoot = await mkdtemp(join(tmpdir(), "lbc-test-runs-"));
    savedRunRoot = process.env.LBC_RUN_ROOT;
    process.env.LBC_RUN_ROOT = testRunRoot;
    savedKeys = {};
    for (const k of PROVIDER_KEYS) {
      savedKeys[k] = process.env[k];
    }
  });

  afterEach(async () => {
    for (const k of PROVIDER_KEYS) {
      if (savedKeys[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedKeys[k];
      }
    }
    if (savedRunRoot === undefined) {
      delete process.env.LBC_RUN_ROOT;
    } else {
      process.env.LBC_RUN_ROOT = savedRunRoot;
    }
    await rm(testRunRoot, { recursive: true, force: true });
  });

  test("POST valid spec returns 200 with cell_id matching cellIdFor", async () => {
    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);
    const app = createApp({ registry });

    const body: RunSpec = {
      task: "prose_substrate_thesis",
      model_pool: ["claude-opus-4-7"],
      condition: { kind: "single_agent", n: 1 },
      grade: true,
    };

    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { run_ts: string; cell_id: string };
    expect(json.run_ts).toBeTruthy();
    const expected = cellIdFor(
      json.run_ts,
      body.task,
      conditionName(body.condition.kind, body.condition.n),
    );
    expect(json.cell_id).toBe(expected);
  });

  test("POST ensemble_multi_round with n=1 returns 400", async () => {
    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);
    const app = createApp({ registry });

    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "prose_substrate_thesis",
        model_pool: ["claude-opus-4-7"],
        condition: { kind: "ensemble_multi_round", n: 1 },
        grade: true,
      }),
    });

    expect(res.status).toBe(400);
  });

  test("POST with empty model_pool returns 400", async () => {
    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);
    const app = createApp({ registry });

    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "prose_substrate_thesis",
        model_pool: [],
        condition: { kind: "single_agent", n: 1 },
        grade: true,
      }),
    });

    expect(res.status).toBe(400);
  });

  test("POST with no provider key returns 200 with warning", async () => {
    for (const k of PROVIDER_KEYS) delete process.env[k];

    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);
    const app = createApp({ registry });

    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: "prose_substrate_thesis",
        model_pool: ["claude-opus-4-7"],
        condition: { kind: "single_agent", n: 1 },
        grade: true,
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { warning?: string };
    expect(typeof json.warning).toBe("string");
    expect(json.warning).toContain("ANTHROPIC_API_KEY");
  });

  test("GET /api/runs reflects running then completed record", async () => {
    const { launcher, resolve } = makeStub(0);
    const registry = new RunRegistry(launcher);
    const app = createApp({ registry });

    // Launch via POST so the record is in the registry
    await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(BASE_SPEC),
    });

    const runningRes = await app.request("/api/runs");
    expect(runningRes.status).toBe(200);
    const running = (await runningRes.json()) as { runs: Array<{ status: string }> };
    expect(running.runs).toHaveLength(1);
    expect(running.runs[0]!.status).toBe("running");

    resolve();
    await new Promise<void>((r) => setTimeout(r, 0));

    const doneRes = await app.request("/api/runs");
    const done = (await doneRes.json()) as { runs: Array<{ status: string }> };
    expect(done.runs[0]!.status).toBe("exited");
  });

  test("DELETE unknown runId returns 404", async () => {
    const { launcher } = makeStub(0);
    const registry = new RunRegistry(launcher);
    const app = createApp({ registry });

    const res = await app.request("/api/runs/no-such-run", {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("unknown run");
  });
});
