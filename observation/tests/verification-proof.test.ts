import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KbblHealth, ObservationHealth } from "../../kbbl/core/server/handlers/observation-health";
import { err, ok } from "../src/domain/primitives";
import { runProof } from "../verification/proof";
import { launcherStateSchema, NO_EVIDENCE, PENDING_SCENARIOS, redactReport, reportStatus, scenarioStatus, type LauncherState,
  type ObservationStatus, type ScenarioReport } from "../verification/proof-contract";
import { liveScenario, runtimeScenario } from "../verification/scenarios";
import type { ProofIo } from "../verification/shadow-session";
import { sourceRunScenario, type SourceRunInput } from "../verification/source-run";

const repository = resolve(import.meta.dir, "../..");
const state: LauncherState = launcherStateSchema.parse({ name: "test", state_dir: "/state",
  kbbl: { port: 1, url: "http://kbbl", data_dir: "/state/kbbl" }, dbos: { port: 2, url: "http://dbos" },
  postgres: { container: "c", volume: "v", port: 3, authority_database: "oakridge" },
  observation: { port: 4, url: "http://observation", database: "observation", namespace: "shadow-test",
    ingest_token_file: "/i", read_token_file: "/r", grade_token_file: "/g", status_file: "/s" }, provider_env_file: "/env" });

const kbblHealth = (observation: ObservationHealth): KbblHealth => ({ status: "ok", observation, capabilities: { read: true, grade: true } });
const status = (value: ObservationStatus["state"], detail = ""): ObservationStatus => ({ state: value, detail, recorded_at: "now" });

/** A stack whose answers the test fixes; nothing here reaches a process or network. */
function fakeIo(overrides: Partial<ProofIo> = {}): ProofIo {
  return { state, startStack: async () => ok(undefined), stopStack: async () => {}, stackAnswers: async () => false,
    observationStatus: async () => status("running", "pid_42"), kbblHealth: async () => kbblHealth({ state: "no_configured_graders" }),
    dbosHealthy: async () => true,
    tokens: async () => ok({ capabilities: { ingest: "i", read: "r", grade: "g" }, private_files: true }),
    shadowQuery: async () => ok("1"), killObservation: () => {}, dbos: async () => ok({}), observationGet: async () => ok({}),
    sleep: async () => {}, ...overrides };
}
const failing = (report: ScenarioReport) => report.checks.filter((check) => !check.passed).map((check) => check.name);

describe("the live proof's prerequisites", () => {
  test("a missing configured key fails the proof and keeps the launcher's reason", async () => {
    const report = await liveScenario(fakeIo({ kbblHealth: async () => kbblHealth({ state: "down", reason: "unreachable" }),
      observationStatus: async () => status("preflight_failed", "missing_credential:TYPESAFE_API_KEY") }));
    expect(report.status).toBe("failed");
    expect(report.checks[0]?.detail).toContain("missing_credential:TYPESAFE_API_KEY");
  });

  test("a stack that survived observation's failure is not a passed proof", async () => {
    const report = await liveScenario(fakeIo({ kbblHealth: async () => kbblHealth({ state: "down", reason: "database_unavailable" }),
      observationStatus: async () => status("exited", "status_1") }));
    expect(report.status).toBe("failed");
    expect(report.checks[0]?.detail).toContain("down");
  });

  test("a reachable service with no configured graders fails the proof", async () => {
    const report = await liveScenario(fakeIo());
    expect(failing(report)).toEqual(["the service registered its configured graders"]);
  });

  test("registered graders and both capabilities satisfy the prerequisites", async () => {
    const report = await liveScenario(fakeIo({ kbblHealth: async () => kbblHealth({ state: "configured",
      graders: [{ runner: "jev_direct", evaluatorDefinitionId: "evaluator-1" }] }) }));
    expect(report.status).toBe("passed");
  });

  test("a stack that cannot start fails rather than skips", async () => {
    const report = await liveScenario(fakeIo({ startStack: async () => err({ operation: "start_stack", entity_id: "x", detail: "no docker" }) }));
    expect(report).toMatchObject({ status: "failed", checks: [{ passed: false, detail: "no docker" }] });
  });

  test("it leaves a stack it attached to running, and stops one it started", async () => {
    let stops = 0;
    const stopStack = async () => { stops += 1; };
    await liveScenario(fakeIo({ stopStack, stackAnswers: async () => true }));
    expect(stops).toBe(0);
    await liveScenario(fakeIo({ stopStack }));
    expect(stops).toBe(1);
  });
});

describe("the runtime scenario", () => {
  test("it refuses a stack it did not start, because it kills and restarts one", async () => {
    let started = false;
    const report = await runtimeScenario(fakeIo({ stackAnswers: async () => true, startStack: async () => { started = true; return ok(undefined); } }));
    expect(report.status).toBe("failed");
    expect(started).toBe(false);
  });

  test("observation that never came up fails with the recorded reason and stops the stack", async () => {
    let stopped = false;
    const report = await runtimeScenario(fakeIo({ kbblHealth: async () => kbblHealth({ state: "down", reason: "unreachable" }),
      observationStatus: async () => status("preflight_failed", "database_provisioning_failed"), stopStack: async () => { stopped = true; } }));
    expect(report.status).toBe("failed");
    expect(report.checks.at(-1)?.detail).toContain("database_provisioning_failed");
    expect(stopped).toBe(true);
  });

  test("a service that stays up after being killed fails the degradation check", async () => {
    const report = await runtimeScenario(fakeIo());
    expect(failing(report)).toContain("kbbl reports observation down after it dies");
  });
});

describe("the source run", () => {
  const input: SourceRunInput = { title: "t", spec: "s", primary_repository_key: "r", final_merge_policy: "require_merge", repositories: [{ key: "r",
    preparation: { repository_path: "/r", expected_head: null }, forge: { owner: "o", name: "n", build_base: "b", final_base: "f" } }] };
  const awaiting = (review: string) => ({ kind: "awaiting_review", review, unit_id: "run-1/unit", target: "revision-1" });

  /** Answers each inspect with the next view, and records every request after that. */
  async function drive(views: readonly unknown[], through: "plan" | "brief" | "assessment" = "plan") {
    const directory = mkdtempSync(join(tmpdir(), "source-run-"));
    const posted: string[] = [];
    let reads = 0;
    const report = await sourceRunScenario(fakeIo({ dbos: async (path, body) => {
      if (path === "/api/runs") return ok({ run_id: "run-1" });
      if (path.endsWith("/inspect")) { reads += 1; return ok(views[Math.min(reads, views.length) - 1]); }
      if (body !== undefined) posted.push(path);
      return ok({});
    }, shadowQuery: async () => ok("[]") }), { input, directory, through, timeout_ms: 1_000 });
    const retained = readdirSync(directory).toSorted();
    rmSync(directory, { recursive: true, force: true });
    return { report, posted, retained };
  }

  test("it accepts planning reviews, retains the run and cancels at the target", async () => {
    const { report, posted, retained } = await drive([{ artifacts: [], attention: [awaiting("plan_review")] },
      { artifacts: [{ artifact_key: "plan", latest_revision: { id: "revision-1" } }], attention: [] }]);
    expect(report.status).toBe("passed");
    expect(posted).toEqual(["/api/runs/run-1/units/run-1%2Funit/reviews/plan_review/decide", "/api/runs/run-1/cancel"]);
    expect(retained).toEqual(["authority-rows.json", "inspect.json", "run.json"]);
    expect(report.evidence.runs[0]?.run_id).toBe("run-1");
  });

  test("it never approves an assessment or integration review", async () => {
    const { posted } = await drive([{ artifacts: [], attention: [awaiting("assessment_review"), awaiting("integration_review")] },
      { artifacts: [{ artifact_key: "assessment", latest_revision: { id: "revision-1" } }], attention: [] }], "assessment");
    expect(posted).toEqual(["/api/runs/run-1/cancel"]);
  });

  test("a brief review stands unless the capture goes through assessment", async () => {
    const { posted } = await drive([{ artifacts: [], attention: [awaiting("brief_review")] },
      { artifacts: [{ artifact_key: "brief", latest_revision: { id: "revision-1" } }], attention: [] }], "brief");
    expect(posted).toEqual(["/api/runs/run-1/cancel"]);
  });

  test("a run needing intervention fails and is still canceled", async () => {
    const { report, posted } = await drive([{ artifacts: [], attention: [{ kind: "worker_failed" }] }]);
    expect(report.status).toBe("failed");
    expect(report.checks[0]?.detail).toContain("needs intervention");
    expect(posted).toEqual(["/api/runs/run-1/cancel"]);
  });

  test("a launch the authority refuses is a failed proof", async () => {
    const directory = mkdtempSync(join(tmpdir(), "source-run-"));
    const report = await sourceRunScenario(fakeIo({ dbos: async () => err({ operation: "dbos_request", entity_id: "x", detail: "HTTP 400" }) }),
      { input, directory, through: "plan" });
    rmSync(directory, { recursive: true, force: true });
    expect(report).toMatchObject({ status: "failed", checks: [{ detail: "HTTP 400" }] });
  });
});

describe("reports", () => {
  const passed: ScenarioReport = { id: "runtime", status: "passed", evidence: NO_EVIDENCE, checks: [{ name: "n", passed: true, detail: "d" }] };
  const run = (scenario: () => Promise<ScenarioReport>, secrets: readonly string[] = []) => runProof({ proof_id: "p", scenario_id: "live", source: { git_head: "abc", worktree_clean: true },
    launcher: state, scenario, secrets: async () => secrets, now: () => new Date("2026-11-06T00:00:00Z") });

  test("no checks is not a pass", () => {
    expect(scenarioStatus([])).toBe("failed");
  });

  test("a scenario not run does not make a passing report", () => {
    expect(reportStatus({ ...passed, status: "not_run" })).toBe("failed");
  });

  test("a scenario that throws is a failed report with its reason", async () => {
    const { report } = await run(async () => { throw new Error("database refused"); });
    expect(report.status).toBe("failed");
    expect(report.scenario).toMatchObject({ id: "live", checks: [{ detail: "database refused" }] });
  });

  test("a secret that reached a report is removed and fails it", async () => {
    const { report, text } = await run(async () => ({ ...passed, checks: [{ name: "n", passed: true, detail: "token-value" }] }), ["token-value"]);
    expect(text).not.toContain("token-value");
    expect(report.status).toBe("failed");
  });

  test("a clean report passes unchanged and lists what is still unproven", async () => {
    const { report } = await run(async () => passed, ["token-value"]);
    expect(report.status).toBe("passed");
    expect(report.pending).toEqual(PENDING_SCENARIOS);
  });

  test("evidence not observed stays null, never a count", () => {
    expect(NO_EVIDENCE.provider_request_count).toBeNull();
    expect(redactReport("abc", [""])).toEqual({ text: "abc", redacted: 0 });
  });
});

describe("one program, one launcher", () => {
  test("no retired proof path remains", () => {
    for (const path of ["oakridge-dbos/scripts/live-source-run.ts", "oakridge-dbos/scripts/live-source-agent.ts", "oakridge-dbos/scripts/live-source-git.ts",
      "observation/scripts/jev-live-walkthrough.ts", "observation/scripts/live-grade-subject.ts", "observation/scripts/regenerate-live-fixtures.ts"])
      expect({ path, exists: existsSync(resolve(repository, path)) }).toEqual({ path, exists: false });
  });

  test("the launcher pair is the only one", () => {
    expect(readdirSync(resolve(repository, "scripts")).filter((name) => name.startsWith("oakridge-")).toSorted())
      .toEqual(["oakridge-lan", "oakridge-shadow", "oakridge-start"]);
  });

  test("no verification module creates a database or starts a service itself", async () => {
    const directory = resolve(import.meta.dir, "../verification");
    for (const name of readdirSync(directory).filter((file) => file.endsWith(".ts"))) {
      const source = await Bun.file(resolve(directory, name)).text();
      for (const banned of ["CREATE DATABASE", "createScratchDatabase", "createApp(", "Bun.serve(", "createProductionComposition", "migrateEmptyDatabase"])
        expect({ name, banned, found: source.includes(banned) }).toEqual({ name, banned, found: false });
    }
  });
});
