import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KbblHealth, ObservationHealth } from "../../kbbl/core/server/handlers/observation-health";
import { err, ok } from "../src/domain/primitives";
import { parseGraderConfiguration, planRegistration } from "../src/grading/configuration";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { RELEVANCE_ID } from "../src/producers/oakridge/questions";
import { runProof } from "../verification/proof";
import { editedGraders, registrationScenario, type RegistrationCapture } from "../verification/registration";
import { launcherStateSchema, NO_EVIDENCE, PENDING_SCENARIOS, redactReport, reportStatus, scenarioStatus, type LauncherState,
  type ObservationStatus, type ScenarioReport } from "../verification/proof-contract";
import { liveScenario, runtimeScenario } from "../verification/scenarios";
import { awaitRunCapture, isRunCaptured, readRunCapture } from "../verification/run-capture";
import { awaitLaunch, type LaunchedProcess, type ProofIo } from "../verification/shadow-session";
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
  let clock = 0;
  return { state, startStack: async () => ok(undefined), stopStack: async () => {}, stackAnswers: async () => false,
    observationStatus: async () => status("running", "pid_42"), kbblHealth: async () => kbblHealth({ state: "no_configured_graders" }),
    dbosHealthy: async () => true,
    tokens: async () => ok({ capabilities: { ingest: "i", read: "r", grade: "g" }, private_files: true }),
    shadowQuery: async () => ok("1"), killObservation: () => {}, dbos: async () => ok({}), observationGet: async () => ok({}),
    publisherFailures: async () => [], readGraders: async () => "{}", writeGraders: async () => {},
    now: () => clock, sleep: async (ms) => { clock += ms; }, ...overrides };
}
const failing = (report: ScenarioReport) => report.checks.filter((check) => !check.passed).map((check) => check.name);

interface FeedEvent { readonly id: string; readonly commit_txid: string; readonly kind: string; readonly artifact: string | null }
interface FeedOutcome { readonly event_id: string; readonly event_kind: string; readonly outcome_kind: string; readonly reason: string | null; readonly revision_id: string | null }
const launched: FeedEvent = { id: "e1", commit_txid: "5", kind: "launched", artifact: null };
const published = (artifact: string): FeedEvent => ({ id: "e2", commit_txid: "6", kind: "revision_published", artifact });
const outcomeOf = (event: FeedEvent): FeedOutcome => ({ event_id: event.id, event_kind: event.kind, reason: null,
  outcome_kind: event.artifact ? "artifact_revision" : "run_input", revision_id: event.artifact ? `oakridge:shadow-test:unit:${event.artifact}:1` : null });

/** A run's two sides of the feed: what the authority holds and what the service recorded. */
interface Feed { readonly events: readonly FeedEvent[]; readonly outcomes: readonly FeedOutcome[]; readonly cursor: { readonly commit_txid: string; readonly id: string } }
const caughtUp = (artifact: string): Feed => {
  const events = [launched, published(artifact)];
  return { events, outcomes: events.map(outcomeOf), cursor: { commit_txid: "6", id: "e2" } };
};
/** IO that answers capture reads from `feed`, which a test may swap between reads. */
const feedIo = (feed: () => Feed): Pick<ProofIo, "shadowQuery" | "observationGet"> => ({
  shadowQuery: async (database, query) => {
    if (database === state.observation.database) return ok(JSON.stringify(feed().outcomes));
    return ok(query.includes("json_build_object") ? JSON.stringify(feed().events) : "[]");
  },
  observationGet: async (path) => {
    if (path.endsWith("/cursor")) return ok({ cursor: feed().cursor });
    const revision_id = decodeURIComponent(path.split("/").at(-1) ?? "");
    return ok({ revision_id, run_id: "run-1", artifact_kind: revision_id.split(":").at(-2) });
  },
});
const refused = (detail: string) => err({ operation: "observation_request", entity_id: "x", detail });

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

  test("a head and cursor that agree do not pass a run the service never recorded", async () => {
    const io = feedIo(() => ({ ...caughtUp("plan"), outcomes: [] }));
    const report = await runtimeScenario(fakeIo({ ...io, dbos: async (path) => ok(path === "/api/runs" ? { run_id: "run-1" } : {}),
      shadowQuery: async (database, query) => query.includes("LIMIT 1") ? ok("6/e2") : io.shadowQuery(database, query) }));
    expect(failing(report)).toContain("the ordered feed delivered every event of the run");
    expect(report.evidence.run_capture?.undelivered_event_ids).toEqual(["e1", "e2"]);
  });
});

describe("a run's capture", () => {
  const request = { run_id: "run-1", target_artifact: "plan" };
  const read = (feed: Feed, overrides: Partial<ProofIo> = {}) => readRunCapture(fakeIo({ ...feedIo(() => feed), ...overrides }), request);

  test("every event delivered, mapped and the target served is captured", async () => {
    const capture = await read(caughtUp("plan"));
    expect(isRunCaptured(capture)).toBe(true);
    expect(capture).toMatchObject({ authority_events: 2, delivered_events: 2, target_revision: "oakridge:shadow-test:unit:plan:1", read_failures: [] });
  });

  test("a cursor past the run does not stand in for the run's own outcomes", async () => {
    const feed = caughtUp("plan");
    const capture = await read({ ...feed, outcomes: feed.outcomes.slice(0, 1), cursor: { commit_txid: "9", id: "other-run" } });
    expect(isRunCaptured(capture)).toBe(false);
    expect(capture.undelivered_event_ids).toEqual(["e2"]);
  });

  test("outcomes without a cursor at the run are not captured", async () => {
    expect(isRunCaptured(await read({ ...caughtUp("plan"), cursor: { commit_txid: "5", id: "e1" } }))).toBe(false);
  });

  test("the cursor compares by number, not as text", async () => {
    expect(isRunCaptured(await read({ ...caughtUp("plan"), cursor: { commit_txid: "10", id: "a" } }))).toBe(true);
  });

  test("a run the authority holds no events for is not captured", async () => {
    expect(isRunCaptured(await read({ events: [], outcomes: [], cursor: { commit_txid: "6", id: "e2" } }))).toBe(false);
  });

  test("no target revision among the run's events is not captured", async () => {
    const events = [launched];
    expect(isRunCaptured(await read({ events, outcomes: events.map(outcomeOf), cursor: { commit_txid: "5", id: "e1" } }))).toBe(false);
  });

  test("a revision the service will not serve back is not captured", async () => {
    const io = feedIo(() => caughtUp("plan"));
    const capture = await read(caughtUp("plan"), { observationGet: async (path, capability) =>
      path.endsWith("/cursor") ? io.observationGet(path, capability) : refused("HTTP 404") });
    expect(isRunCaptured(capture)).toBe(false);
    expect(capture.read_failures).toEqual(["observation_request: HTTP 404"]);
  });

  test("a revision from another run is not the target", async () => {
    const io = feedIo(() => caughtUp("plan"));
    const capture = await read(caughtUp("plan"), { observationGet: async (path, capability) =>
      path.endsWith("/cursor") ? io.observationGet(path, capability) : ok({ revision_id: "r", run_id: "run-2", artifact_kind: "plan" }) });
    expect(capture.target_revision).toBeNull();
  });

  test("the wait is bounded, and lag retains what is missing and why", async () => {
    let reads = 0;
    const feed = caughtUp("plan");
    const lagging: Feed = { ...feed, outcomes: feed.outcomes.slice(0, 1), cursor: { commit_txid: "5", id: "e1" } };
    const capture = await awaitRunCapture(fakeIo({ ...feedIo(() => { reads += 1; return lagging; }),
      publisherFailures: async () => ["observation publisher: observation delivery HTTP 400"] }), request, 5_000);
    expect(isRunCaptured(capture)).toBe(false);
    expect(reads).toBeLessThan(30);
    expect(capture).toMatchObject({ undelivered_event_ids: ["e2"], diagnostics: { publisher_failures: ["observation publisher: observation delivery HTTP 400"] } });
  });

  test("delivery that catches up within the bound is captured", async () => {
    let cursor_reads = 0;
    const feed = caughtUp("plan");
    const lagging: Feed = { ...feed, outcomes: feed.outcomes.slice(0, 1) };
    const io = fakeIo({ ...feedIo(() => { cursor_reads += 1; return cursor_reads < 9 ? lagging : feed; }) });
    expect(isRunCaptured(await awaitRunCapture(io, request, 60_000))).toBe(true);
  });

  test("an unmapped event ends the wait, because it stays unmapped", async () => {
    const feed = caughtUp("plan");
    let sleeps = 0;
    const rejected: Feed = { ...feed, outcomes: [feed.outcomes[0]!, { ...feed.outcomes[1]!, outcome_kind: "unmapped", reason: "no artifact declaration", revision_id: null }] };
    const capture = await awaitRunCapture(fakeIo({ ...feedIo(() => rejected), sleep: async () => { sleeps += 1; } }), request, 5_000);
    expect(sleeps).toBe(0);
    expect(capture.unmapped).toEqual([{ event_id: "e2", event_kind: "revision_published", reason: "no artifact declaration" }]);
  });
});

describe("the source run", () => {
  const input: SourceRunInput = { title: "t", spec: "s", primary_repository_key: "r", final_merge_policy: "require_merge", repositories: [{ key: "r",
    preparation: { repository_path: "/r", expected_head: null }, forge: { owner: "o", name: "n", build_base: "b", final_base: "f" } }] };
  const awaiting = (review: string) => ({ kind: "awaiting_review", review, unit_id: "run-1/unit", target: "revision-1" });

  /** Answers each inspect with the next view, and records every request after that. */
  async function drive(views: readonly unknown[], through: "plan" | "brief" | "assessment" = "plan", overrides: Partial<ProofIo> = {}) {
    const directory = mkdtempSync(join(tmpdir(), "source-run-"));
    const posted: string[] = [];
    let reads = 0;
    const report = await sourceRunScenario(fakeIo({ dbos: async (path, body) => {
      if (path === "/api/runs") return ok({ run_id: "run-1" });
      if (path.endsWith("/inspect")) { reads += 1; return ok(views[Math.min(reads, views.length) - 1]); }
      if (body !== undefined) posted.push(path);
      return ok({});
    }, ...feedIo(() => caughtUp(through)), ...overrides }), { input, directory, through, timeout_ms: 60_000, capture_timeout_ms: 5_000 });
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

  const reached = [{ artifacts: [{ artifact_key: "plan", latest_revision: { id: "revision-1" } }], attention: [] }];

  test("it reports the capture it passed on, with the revisions it covered", async () => {
    const { report } = await drive(reached);
    expect(report.evidence.run_capture).toMatchObject({ run_id: "run-1", target_artifact: "plan", delivered_events: 2 });
    expect(report.evidence.source_revisions).toEqual(["oakridge:shadow-test:unit:plan:1"]);
  });

  test("observation down before launch fails without spending a turn", async () => {
    let launches = 0;
    const directory = mkdtempSync(join(tmpdir(), "source-run-"));
    const report = await sourceRunScenario(fakeIo({ kbblHealth: async () => kbblHealth({ state: "down", reason: "unreachable" }),
      observationStatus: async () => status("preflight_failed", "missing_credential:TYPESAFE_API_KEY"),
      dbos: async () => { launches += 1; return ok({ run_id: "run-1" }); } }), { input, directory, through: "plan" });
    rmSync(directory, { recursive: true, force: true });
    expect(launches).toBe(0);
    expect(report).toMatchObject({ status: "failed", checks: [{ passed: false }] });
    expect(report.checks[0]?.detail).toContain("missing_credential:TYPESAFE_API_KEY");
  });

  test("observation lost during the run fails a healthy stack, and keeps the reason", async () => {
    let settled = false;
    const { report, posted } = await drive(reached, "plan", {
      kbblHealth: async () => { const health = kbblHealth(settled ? { state: "down", reason: "unreachable" } : { state: "no_configured_graders" }); settled = true; return health; },
      observationStatus: async () => status(settled ? "exited" : "running", settled ? "status_1" : "pid_42"),
      observationGet: async () => refused("no response") });
    expect(report.status).toBe("failed");
    expect(failing(report)).toEqual(["the ordered feed delivered every event of the run", "the service serves the target revision"]);
    expect(report.checks.find((check) => !check.passed)?.detail).toContain("health down; launcher exited: status_1");
    expect(posted).toEqual(["/api/runs/run-1/cancel"]);
  });

  test("capture that stays behind fails, though the run reached its target", async () => {
    const feed = caughtUp("plan");
    const { report } = await drive(reached, "plan", feedIo(() => ({ ...feed, outcomes: feed.outcomes.slice(0, 1), cursor: { commit_txid: "5", id: "e1" } })));
    expect(report.status).toBe("failed");
    expect(report.checks[0]).toMatchObject({ name: "the run reaches its target", passed: true });
    expect(report.evidence.run_capture?.undelivered_event_ids).toEqual(["e2"]);
  });

  test("capture refused by the service fails, and the publisher's reason is kept", async () => {
    const feed = caughtUp("plan");
    const { report } = await drive(reached, "plan", { ...feedIo(() => ({ ...feed, outcomes: feed.outcomes.slice(0, 1), cursor: { commit_txid: "5", id: "e1" } })),
      publisherFailures: async () => ["observation publisher: observation delivery HTTP 400"] });
    expect(report.status).toBe("failed");
    expect(report.checks.find((check) => !check.passed)?.detail).toContain("observation delivery HTTP 400");
  });

  test("an unavailable observation database fails with its reason", async () => {
    const io = feedIo(() => caughtUp("plan"));
    const { report } = await drive(reached, "plan", { ...io, shadowQuery: async (database, query) =>
      database === state.observation.database ? err({ operation: "shadow_query", entity_id: database, detail: "database does not exist" }) : io.shadowQuery(database, query) });
    expect(report.status).toBe("failed");
    expect(report.evidence.run_capture?.read_failures).toContain("shadow_query: database does not exist");
  });

  test("capability files that cannot be read fail with their reason", async () => {
    const io = feedIo(() => caughtUp("plan"));
    const { report } = await drive(reached, "plan", { ...io, observationGet: async () => err({ operation: "read_tokens", entity_id: "/state", detail: "ENOENT" }) });
    expect(report.status).toBe("failed");
    expect(report.evidence.run_capture?.read_failures).toContain("read_tokens: ENOENT");
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

describe("the stack's startup wait", () => {
  /** A launcher the test controls: it records the signal it was sent and exits when signaled. */
  function fakeLauncher(exitCode: number | null = null) {
    const signals: string[] = [];
    let exit = (_code: number) => {};
    const exited = new Promise<number>((resolve) => { exit = resolve; });
    const child: LaunchedProcess = { exitCode, exited, kill: (signal) => { signals.push(signal); exit(143); } };
    return { child, signals };
  }
  const waitFor = (answers: () => Promise<boolean>) => {
    let clock = 0;
    return { answers, timeout_ms: 5_000, now: () => clock, sleep: async (ms: number) => { clock += ms; }, log_path: "/log" };
  };

  test("a stack that never answers is stopped before the failure returns", async () => {
    const { child, signals } = fakeLauncher();
    const started = await awaitLaunch(child, waitFor(async () => false));
    expect({ ok: started.ok, signals }).toEqual({ ok: false, signals: ["SIGTERM"] });
  });

  test("a stack that answers is left running", async () => {
    const { child, signals } = fakeLauncher();
    const started = await awaitLaunch(child, waitFor(async () => true));
    expect({ ok: started.ok, signals }).toEqual({ ok: true, signals: [] });
  });

  test("a launcher that already exited is reported, not signaled", async () => {
    const { child, signals } = fakeLauncher(1);
    const started = await awaitLaunch(child, waitFor(async () => false));
    expect({ detail: started.ok ? null : started.error.detail, signals }).toEqual({ detail: "launcher exited with status 1; see /log", signals: [] });
  });
});

describe("the registration scenario", () => {
  const committedText = readFileSync(resolve(repository, "observation/graders.json"), "utf8");
  const plan = (text: string) => {
    const parsed = parseGraderConfiguration(JSON.parse(text));
    if (!parsed.ok) throw new Error(parsed.error.detail);
    const registration = planRegistration(parsed.value, oakridgeProfile.questions);
    if (!registration.ok) throw new Error(registration.error.detail);
    return registration.value;
  };
  const relevancePin = (text: string) => plan(text).capture.pins.find((pin) => pin.question_id === RELEVANCE_ID)!;

  /** A shadow whose observation registers whatever graders.json held when it last started, and
   * pins each run's one finding with the selection in force when that run was captured. */
  function shadow(options: { readonly repin_after_restart?: boolean; readonly executions?: number } = {}) {
    let graders = committedText;
    let running: string | null = null;
    const stored = new Set<string>();
    const pinnedAt = new Map<string, string>();
    const writes: string[] = [];
    const io = fakeIo({
      readGraders: async () => graders,
      writeGraders: async (text) => { graders = text; writes.push(text); },
      startStack: async () => { running = graders; for (const evaluator of plan(graders).evaluators) stored.add(evaluator.evaluator_definition_id); return ok(undefined); },
      stopStack: async () => { running = null; },
      kbblHealth: async () => kbblHealth(running ? { state: "configured", graders: plan(running).graders.map((grader) =>
        ({ runner: grader.runner, evaluatorDefinitionId: grader.evaluator_definition_id })) } : { state: "down", reason: "unreachable" }),
      shadowQuery: async (_database, query) => ok(query.includes("evaluator_definition_id")
        ? JSON.stringify([...stored]) : JSON.stringify({ executions: options.executions ?? 0, attempts: 0, requests_sent: 0, answers: 0 })),
      observationGet: async (path) => {
        const run = /\/v1\/runs\/([^/]+)\/items/.exec(path)?.[1];
        if (run) return ok({ items: [{ occurrence_id: `occ-${run}`, revision_id: `analysis-${run}`, json_pointer: "/findings/0", item_kind: "finding" }] });
        const occurrence = decodeURIComponent(/\/v1\/items\/([^/]+)\/evidence/.exec(path)?.[1] ?? "");
        const selection = options.repin_after_restart && running ? running : pinnedAt.get(occurrence) ?? committedText;
        const pin = relevancePin(selection);
        return ok({ items: [{ evidence_set_id: `set-${occurrence}`, question_id: pin.question_id, question_version: pin.question_version,
          pinned_evaluator_definition_ids: pin.evaluator_definition_ids,
          readiness: { state: "ready", ready_at: "2026-11-07T00:00:00Z", references: [{ ref: "subject", source: "revision", revision_id: `analysis-${occurrence}`, item_path: "/findings/0" }] } }] });
      },
    });
    const capture: RegistrationCapture = async (label) => {
      const run_id = `run-${label}`;
      pinnedAt.set(`occ-${run_id}`, running ?? committedText);
      return { run: { run_id, definition_id: "development" }, report: { id: "source-run", status: "passed", checks: [{ name: "captured", passed: true, detail: "" }], evidence: NO_EVIDENCE } };
    };
    return { io, capture, writes, graders: () => graders };
  }

  test("an edit is a new definition: old pins stay, later captures take the edit, nothing is graded", async () => {
    const stack = shadow();
    const report = await registrationScenario(stack.io, stack.capture);
    expect(failing(report)).toEqual([]);
    expect(report.evidence.registrations.map((entry) => entry.checkpoint)).toEqual(["committed", "edited"]);
    const [first, , second] = ["first", "first-after-swap", "second"].map((checkpoint) => report.evidence.pins.find((pin) => pin.checkpoint === checkpoint)!);
    expect(first!.pinned_evaluator_definition_ids).not.toEqual(second!.pinned_evaluator_definition_ids);
    expect(report.evidence.provider_request_count).toBe(0);
    expect(stack.graders()).toBe(committedText);
  });

  test("a restart that repins earlier captures fails the proof", async () => {
    const report = await registrationScenario(shadow({ repin_after_restart: true }).io, shadow().capture);
    expect(failing(report)).toContain("the first run keeps its pins and frozen evidence after the swap");
  });

  test("an execution created by capture or restart fails the proof", async () => {
    const stack = shadow({ executions: 1 });
    expect(failing(await registrationScenario(stack.io, stack.capture))).toContain("capture and collection execute nothing");
  });

  test("the committed selection is restored even when the stack does not start", async () => {
    const stack = shadow();
    const report = await registrationScenario({ ...stack.io, startStack: async () => err({ operation: "start_stack", entity_id: "x", detail: "down" }) }, stack.capture);
    expect(report.status).toBe("failed");
    expect(stack.graders()).toBe(committedText);
  });

  test("the edit changes only graders.json and keeps every runner and model", () => {
    const committed = parseGraderConfiguration(JSON.parse(committedText));
    if (!committed.ok) throw new Error(committed.error.detail);
    const edited = editedGraders(committed.value);
    expect(edited.questions.flatMap((entry) => entry.graders.map((grader) => [grader.runner, grader.model])))
      .toEqual(committed.value.questions.flatMap((entry) => entry.graders.map((grader) => [grader.runner, grader.model])));
    expect(planRegistration(edited, oakridgeProfile.questions).ok).toBe(true);
  });
});
