import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KbblHealth, ObservationHealth } from "../../kbbl/core/server/handlers/observation-health";
import { err, ok } from "../src/domain/primitives";
import { parseGraderConfiguration, planRegistration } from "../src/grading/configuration";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { ASSESSMENT_FINDING_KIND, FINDING_KIND } from "../src/producers/oakridge/catalogue";
import { runProof } from "../verification/proof";
import { editedGraders, registrationScenario, type RegistrationSource } from "../verification/registration";
import { launcherStateSchema, NO_EVIDENCE, PENDING_SCENARIOS, redactReport, reportStatus, scenarioStatus, type LauncherState,
  type ObservationStatus, type ScenarioReport } from "../verification/proof-contract";
import { liveScenario, runtimeScenario } from "../verification/scenarios";
import { awaitRunCapture, isRunCaptured, readRunCapture } from "../verification/run-capture";
import { awaitLaunch, type LaunchedProcess, type ProofIo } from "../verification/shadow-session";
import { relationsScenario } from "../verification/relations";
import { sourceRunScenario, type ReviewCheckpoint, type SourceRunInput } from "../verification/source-run";

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

test("a relations run that gave the proof none of its steps cannot read as a pass", async () => {
  const graders = await Bun.file(resolve(import.meta.dir, "../graders.json")).text();
  const run = { run_id: "run-1", definition_id: "definition-1" };
  const report = await relationsScenario(fakeIo({ readGraders: async () => graders }), { shared_input: {} as SourceRunInput,
    run: async () => ({ report: { id: "source-run", status: "passed", checks: [], evidence: NO_EVIDENCE }, run }),
    openObservation: async () => ok({ db: {} as never, tenant: { producer: "oakridge", namespace: "n" }, close: async () => {} }) }, "matrix");
  expect([report.status, failing(report)]).toEqual(["failed", ["the links run gave the proof its findings and tasks"]]);
});

describe("the source run", () => {
  const input: SourceRunInput = { title: "t", spec: "s", primary_repository_key: "r", final_merge_policy: "require_merge", repositories: [{ key: "r",
    preparation: { repository_path: "/r", expected_head: null }, forge: { owner: "o", name: "n", build_base: "b", final_base: "f" } }] };
  const awaiting = (review: string) => ({ kind: "awaiting_review", review, unit_id: "run-1/unit", target: "revision-1" });

  /** Answers each inspect with the next view, and records every request after that. */
  async function drive(views: readonly unknown[], through: "plan" | "brief" | "assessment" = "plan", overrides: Partial<ProofIo> = {}, reviews: readonly ReviewCheckpoint[] = []) {
    const directory = mkdtempSync(join(tmpdir(), "source-run-"));
    const posted: string[] = [];
    let reads = 0;
    const report = await sourceRunScenario(fakeIo({ dbos: async (path, body) => {
      if (path === "/api/runs") return ok({ run_id: "run-1" });
      if (path.endsWith("/inspect")) { reads += 1; return ok(views[Math.min(reads, views.length) - 1]); }
      if (body !== undefined) posted.push(path);
      return ok({});
    }, ...feedIo(() => caughtUp(through)), ...overrides }), { input, directory, through, timeout_ms: 60_000, capture_timeout_ms: 5_000, reviews });
    const retained = readdirSync(directory).toSorted();
    rmSync(directory, { recursive: true, force: true });
    return { report, posted, retained };
  }

  test("a review's steps run once around its acceptance, and receive the revision it decides", async () => {
    const steps: string[] = [];
    const passed = { name: "step", passed: true, detail: "" };
    const waiting = { artifacts: [], attention: [awaiting("plan_review")] };
    const { report, posted } = await drive([waiting, waiting, { artifacts: [{ artifact_key: "plan", latest_revision: { id: "revision-1" } }], attention: [] }], "plan", {}, [{ review: "plan_review",
      before: async (_run, target) => { steps.push(`before ${target}`); return passed; }, after: async (_run, target) => { steps.push(`after ${target}`); return passed; } }]);
    expect([report.status, steps, posted.filter((path) => path.endsWith("/decide")).length]).toEqual(["passed", ["before revision-1", "after revision-1"], 2]);
  });

  test("a review with feedback is sent back once per unit before its acceptance", async () => {
    const decided: unknown[] = [];
    const awaitingUnit = (unit_id: string, target: string) => ({ kind: "awaiting_review", review: "brief_review", unit_id, target });
    const views = [{ artifacts: [], attention: [awaitingUnit("alpha", "a1"), awaitingUnit("beta", "b1")] }, { artifacts: [], attention: [awaitingUnit("alpha", "a2")] }, { artifacts: [], attention: [awaitingUnit("beta", "b2")] },
      { artifacts: [{ artifact_key: "assessment", latest_revision: { id: "x1" } }, { artifact_key: "assessment", latest_revision: { id: "x2" } }], attention: [] }];
    const directory = mkdtempSync(join(tmpdir(), "source-run-"));
    let reads = 0;
    const report = await sourceRunScenario(fakeIo({ dbos: async (path, body) => {
      if (path === "/api/runs") return ok({ run_id: "run-1" });
      if (path.endsWith("/inspect")) { reads += 1; return ok(views[Math.min(reads, views.length) - 1]); }
      if (path.endsWith("/decide")) decided.push([(body as { decision: string }).decision, (body as { target: string }).target]);
      return ok({});
    }, ...feedIo(() => caughtUp("assessment")) }), { input, directory, through: "assessment", timeout_ms: 60_000, capture_timeout_ms: 5_000, target_units: 2, reviews: [{ review: "brief_review", revision_feedback: "again" }] });
    rmSync(directory, { recursive: true, force: true });
    expect([report.status, decided]).toEqual(["passed", [["request_changes", "a1"], ["request_changes", "b1"], ["accept", "a2"], ["accept", "b2"]]]);
  });

  test("the target waits for as many units as asked, and an acceptance carries the links its review supplies", async () => {
    const posted: { readonly analysis_links?: unknown }[] = [];
    const reached = { artifacts: [{ artifact_key: "plan", latest_revision: { id: "p1" } }], attention: [awaiting("plan_review")] };
    const views = [reached, { artifacts: [{ artifact_key: "plan", latest_revision: { id: "p1" } }, { artifact_key: "plan", latest_revision: { id: "p2" } }], attention: [] }];
    const directory = mkdtempSync(join(tmpdir(), "source-run-"));
    let reads = 0;
    const links = [{ source_revision_id: "analysis:1", item_path: "/findings/0", task_ids: ["T1"] }];
    const report = await sourceRunScenario(fakeIo({ dbos: async (path, body) => {
      if (path === "/api/runs") return ok({ run_id: "run-1" });
      if (path.endsWith("/inspect")) { reads += 1; return ok(views[Math.min(reads, views.length) - 1]); }
      if (path.endsWith("/decide")) posted.push(body as { analysis_links?: unknown });
      return ok({});
    }, ...feedIo(() => caughtUp("plan")) }), { input, directory, through: "plan", timeout_ms: 60_000, capture_timeout_ms: 5_000, target_units: 2, reviews: [{ review: "plan_review", analysis_links: () => links }] });
    rmSync(directory, { recursive: true, force: true });
    expect([report.status, reads, posted.map((body) => body.analysis_links)]).toEqual(["passed", 2, [links]]);
  });

  describe("a decision whose result is not known", () => {
    const passed = { name: "step", passed: true, detail: "" };
    const links = [{ source_revision_id: "analysis:1", item_path: "/findings/0", task_ids: ["T1"] }];
    const reached = { artifacts: [{ artifact_key: "plan", latest_revision: { id: "revision-1" } }], attention: [] };
    interface Sent { readonly request_id: string; readonly analysis_links?: unknown }
    async function accepting(script: { readonly views: readonly unknown[]; readonly answer: (attempt: number) => ReturnType<ProofIo["dbos"]>; readonly reviews?: readonly ReviewCheckpoint[] }) {
      const steps: string[] = [];
      const sent: Sent[] = [];
      const directory = mkdtempSync(join(tmpdir(), "source-run-"));
      let reads = 0;
      const report = await sourceRunScenario(fakeIo({ dbos: async (path, body) => {
        if (path === "/api/runs") return ok({ run_id: "run-1" });
        if (path.endsWith("/inspect")) { reads += 1; return ok(script.views[Math.min(reads, script.views.length) - 1]); }
        if (path.endsWith("/decide")) { sent.push(body as Sent); return script.answer(sent.length); }
        return ok({});
      }, ...feedIo(() => caughtUp("plan")) }), { input, directory, through: "plan", timeout_ms: 60_000, capture_timeout_ms: 5_000, reviews: script.reviews ?? [{ review: "plan_review", analysis_links: () => links,
        before: async () => { steps.push("before"); return passed; }, after: async () => { steps.push("after"); return passed; } }] });
      rmSync(directory, { recursive: true, force: true });
      return { report, steps, sent };
    }
    const lostResponse = () => Promise.resolve(err({ operation: "dbos", entity_id: "decide", detail: "response timed out" }));

    test("a committed acceptance whose response was lost is asked again under the same id, and its steps still run", async () => {
      // The review has gone from the next view: only repeating the request can learn the outcome.
      const { report, steps, sent } = await accepting({ views: [{ artifacts: [], attention: [awaiting("plan_review")] }, reached], answer: (attempt) => attempt === 1 ? lostResponse() : Promise.resolve(ok({ kind: "committed" })) });
      expect([report.status, steps, sent.map((body) => body.analysis_links), new Set(sent.map((body) => body.request_id)).size]).toEqual(["passed", ["before", "after"], [links, links], 1]);
    });
    test("a decision that never becomes known fails the proof and skips nothing silently", async () => {
      const { report, steps, sent } = await accepting({ views: [{ artifacts: [], attention: [awaiting("plan_review")] }], answer: lostResponse });
      const failed = report.checks.find((entry) => entry.name === "plan_review is accepted");
      expect([report.status, steps, failed?.detail, sent.length > 1]).toEqual(["failed", ["before"], "after 30 attempts: response timed out", true]);
    });
    test("a run reaching its target without a step the proof asked for fails", async () => {
      const { report, steps } = await accepting({ views: [reached], answer: () => Promise.resolve(ok({})) });
      expect([report.status, steps, report.checks.find((entry) => !entry.passed)?.detail]).toEqual(["failed", [], "never taken: plan_review"]);
    });
  });

  test("a failed step ahead of a review ends the run there, without accepting it", async () => {
    const { report, posted } = await drive([{ artifacts: [], attention: [awaiting("plan_review")] }], "plan", {}, [{ review: "plan_review",
      before: async () => ({ name: "the proof's step", passed: false, detail: "not yet" }) }]);
    expect(report.checks.find((entry) => entry.name === "the proof's step")?.detail).toBe("not yet");
    expect(posted.filter((path) => path.endsWith("/decide"))).toEqual([]);
    expect(posted.filter((path) => path.endsWith("/cancel"))).toHaveLength(1);
  });

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

  test("a deferred capture runs the launch hook, reaches the target and leaves the capture wait to its caller", async () => {
    const directory = mkdtempSync(join(tmpdir(), "source-run-"));
    let hooked = "";
    const report = await sourceRunScenario(fakeIo({ dbos: async (path) => ok(path === "/api/runs" ? { run_id: "run-1" } : path.endsWith("/inspect") ? reached[0] : {}),
      ...feedIo(() => ({ events: [launched], outcomes: [], cursor: { commit_txid: "0", id: "e0" } })) }),
      { input, directory, through: "plan", capture: "deferred",
        after_launch: async (run) => { hooked = run.run_id; return { name: "observation is down", passed: true, detail: "" }; } });
    rmSync(directory, { recursive: true, force: true });
    expect(hooked).toBe("run-1");
    expect(report.status).toBe("passed");
    expect(report.evidence.run_capture).toBeNull();
  });

  test("a failed launch hook ends the run there, canceled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "source-run-"));
    const posted: string[] = [];
    const report = await sourceRunScenario(fakeIo({ dbos: async (path, body) => {
      if (body !== undefined) posted.push(path);
      return ok(path === "/api/runs" ? { run_id: "run-1" } : {});
    } }), { input, directory, through: "plan", capture: "deferred",
      after_launch: async () => ({ name: "observation is down", passed: false, detail: "still up" }) });
    rmSync(directory, { recursive: true, force: true });
    expect(failing(report)).toEqual(["observation is down"]);
    expect(posted).toEqual(["/api/runs", "/api/runs/run-1/cancel"]);
  });

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
  const tick = () => new Promise<void>((done) => setImmediate(done));

  interface Occurrence { readonly run_id: string; readonly id: string; readonly revision_id: string; readonly item_path: string;
    readonly item_kind: string; readonly cites_file: boolean; pinned: string | null; ready_at: string | null }
  interface ShadowOptions { readonly repin_after_restart?: boolean; readonly executions?: number; readonly nothing_cited?: boolean;
    readonly never_arrives?: boolean; readonly unstable_evidence?: boolean; readonly drops_correctness?: boolean;
    readonly wrong_commit?: boolean; readonly forgets_evidence?: boolean }

  /** A shadow whose observation registers whatever graders.json held when it last started, pins
   * each captured item with the selection running at its capture, and reads a cited file only
   * while the launch repository is in place. */
  function shadow(options: ShadowOptions = {}) {
    let graders = committedText;
    let running: string | null = null;
    let killed = false;
    let withheld = false;
    let reads = 0;
    let clock = 0;
    let deferred: string | null = null;
    let forgotten = false;
    const feed = caughtUp("assessment");
    const stored = new Set<string>();
    const occurrences: Occurrence[] = [];
    const collect = (occurrence: Occurrence) => {
      if (occurrence.pinned && !occurrence.ready_at && (!occurrence.cites_file || (!withheld && !options.never_arrives)))
        occurrence.ready_at = `2026-11-07T00:00:0${occurrences.indexOf(occurrence)}Z`;
    };
    const capture = (run_id: string, revision_id?: string) => {
      for (const occurrence of occurrences.filter((entry) => entry.run_id === run_id && (!revision_id || entry.revision_id === revision_id))) {
        occurrence.pinned ??= running;
        collect(occurrence);
      }
    };
    const questionsOf = (occurrence: Occurrence) => plan(options.repin_after_restart && running ? running : occurrence.pinned!).capture.pins
      .filter((pin) => pin.item_kind === occurrence.item_kind && !(options.drops_correctness && pin.question_id.endsWith("correctness")));
    const isReady = (occurrence: Occurrence) => occurrence.ready_at !== null && !(forgotten && occurrence.run_id === "run-second" && !occurrence.cites_file
      && occurrence.item_kind === FINDING_KIND);
    const references = (occurrence: Occurrence) => [{ ref: "subject", source: "revision", revision_id: occurrence.revision_id, item_path: occurrence.item_path,
      content: { evidence: occurrence.cites_file ? [{ kind: "file", ref: "core/a.ts:2-3" }] : [], ...options.unstable_evidence ? { read: ++reads } : {} } },
      ...(occurrence.cites_file ? [{ ref: "citation:0", source: "repository", repository_key: "oakridge", commit_sha: options.wrong_commit ? "def" : "abc", path: "core/a.ts",
        line_range: { start: 2, end: 3 }, is_absent: false, content: "two\nthree" }] : [])];
    const io = fakeIo({
      now: () => clock,
      sleep: async (ms) => { clock += ms; await tick(); },
      readGraders: async () => graders,
      writeGraders: async (text) => { graders = text; },
      startStack: async () => {
        running = graders; killed = false;
        for (const evaluator of plan(graders).evaluators) stored.add(evaluator.evaluator_definition_id);
        if (deferred) { capture(deferred); deferred = null; }
        occurrences.forEach(collect);
        return ok(undefined);
      },
      stopStack: async () => { running = null; },
      killObservation: () => { killed = true; },
      kbblHealth: async () => kbblHealth(running && !killed ? { state: "configured", graders: plan(running).graders.map((grader) =>
        ({ runner: grader.runner, evaluatorDefinitionId: grader.evaluator_definition_id })) } : { state: "down", reason: "unreachable" }),
      shadowQuery: async (_database, query) => ok(query.includes("head_sha") ? JSON.stringify(Object.fromEntries(occurrences
        .filter((entry) => entry.revision_id.startsWith("assessment") && query.includes(entry.run_id)).map((entry) => [entry.revision_id, "abc"])))
        : query.includes("evaluator_definition_id") ? JSON.stringify([...stored])
        : query.includes("grading_provider_attempt") ? JSON.stringify({ executions: options.executions ?? 0, attempts: 0, requests_sent: 0, answers: 0 })
          : query.includes("source_event_outcome") ? JSON.stringify(feed.outcomes) : JSON.stringify(feed.events)),
      observationGet: async (path) => {
        const run = /\/v1\/runs\/([^/]+)\/items/.exec(path)?.[1];
        if (run) return ok({ items: occurrences.filter((entry) => entry.run_id === run && entry.pinned).map((entry) =>
          ({ occurrence_id: entry.id, revision_id: entry.revision_id, json_pointer: entry.item_path, item_kind: entry.item_kind })) });
        if (path.includes("/cursor")) return ok({ cursor: feed.cursor });
        const revision = /\/v1\/source-revisions\/(.+)$/.exec(path)?.[1];
        if (revision) return ok({ revision_id: decodeURIComponent(revision), run_id: "run-first", artifact_kind: "assessment" });
        const occurrence = occurrences.find((entry) => path.includes(`/v1/items/${entry.id}/`))!;
        return ok({ items: questionsOf(occurrence).map((pin) => ({ evidence_set_id: `${occurrence.id}:${pin.question_id}`, question_id: pin.question_id,
          question_version: pin.question_version, pinned_evaluator_definition_ids: pin.evaluator_definition_ids,
          readiness: isReady(occurrence) ? { state: "ready", ready_at: occurrence.ready_at, references: references(occurrence) }
            : { state: "not_ready", reason: { code: occurrence.cites_file ? "repository_unavailable" : "collection_pending" } } })) });
      },
    });
    const source: RegistrationSource = {
      async run(label, run_options) {
        const run_id = `run-${label}`;
        const item = (id: string, revision_id: string, item_path: string, item_kind: string, cites_file: boolean) =>
          occurrences.push({ run_id, id: `${run_id}-${id}`, revision_id: `${revision_id}-${run_id}`, item_path, item_kind, cites_file, pinned: null, ready_at: null });
        item("finding", "analysis", "/findings/0", FINDING_KIND, false);
        item("cited", "assessment", "/findings/0", ASSESSMENT_FINDING_KIND, !options.nothing_cited);
        item("uncited", "assessment", "/findings/1", ASSESSMENT_FINDING_KIND, false);
        const launched = await run_options.after_launch({ run_id, definition_id: "development" });
        if (run_options.capture === "deferred") deferred = run_id;
        else {
          capture(run_id, `analysis-${run_id}`);
          for (let turn = 0; turn < 5; turn++) await tick();
          capture(run_id);
          forgotten = Boolean(options.forgets_evidence);
        }
        return { run: { run_id, definition_id: "development" }, report: { id: "source-run", status: launched.passed ? "passed" : "failed",
          checks: [launched], evidence: NO_EVIDENCE } };
      },
      repository_key: "oakridge",
      readCited: async (commit_sha, path) => ok(commit_sha === "abc" && path === "core/a.ts" ? "one\ntwo\nthree\nfour" : null),
      withholdRepository: async () => { withheld = true; return ok("withheld"); },
      supplyRepository: async () => { withheld = false; return ok("supplied"); },
    };
    return { io, source, graders: () => graders, withheld: () => withheld };
  }

  test("a real wait at capture, a swap and restart, the input's arrival and a later capture each keep their own pins", async () => {
    const stack = shadow();
    const report = await registrationScenario(stack.io, stack.source);
    expect(failing(report)).toEqual([]);
    expect(report.evidence.registrations.map((entry) => entry.checkpoint)).toEqual(["committed", "committed, repository withheld",
      "edited, repository withheld", "edited, repository supplied"]);
    const pinOf = (checkpoint: string) => report.evidence.pins.find((pin) => pin.checkpoint === checkpoint && pin.item_path === "/findings/0"
      && pin.item_kind === ASSESSMENT_FINDING_KIND)!;
    expect(pinOf("first-capture")).toMatchObject({ readiness: "not_ready", not_ready_code: "repository_unavailable" });
    expect(pinOf("first-after-arrival")).toMatchObject({ readiness: "ready", pinned_evaluator_definition_ids: pinOf("first-capture").pinned_evaluator_definition_ids });
    expect(pinOf("second").pinned_evaluator_definition_ids).not.toEqual(pinOf("first-capture").pinned_evaluator_definition_ids);
    expect(report.evidence.frozen_evidence.find((set) => set.run_id === "run-first" && set.item_path === "/findings/0" && set.question_id.endsWith("correctness"))
      ?.references).toContainEqual(expect.objectContaining({ source: "repository", commit_sha: "abc", path: "core/a.ts", content: "two\nthree" }));
    expect(report.evidence.provider_request_count).toBe(0);
    expect(stack.graders()).toBe(committedText);
    expect(stack.withheld()).toBe(false);
  });

  test("a capture where nothing waits fails rather than passing vacuously", async () => {
    const report = await registrationScenario(shadow({ nothing_cited: true }).io, shadow({ nothing_cited: true }).source);
    expect(failing(report)).toContain("a required lookup is waiting at capture");
  });

  test("a waiting question that never becomes ready fails the proof", async () => {
    const stack = shadow({ never_arrives: true });
    expect(failing(await registrationScenario(stack.io, stack.source))).toContain("every question waiting at capture is ready once its input is supplied");
  });

  test("a restart that repins earlier captures fails the proof", async () => {
    const stack = shadow({ repin_after_restart: true });
    expect(failing(await registrationScenario(stack.io, stack.source))).toContain("the first run keeps every pin and frozen evidence set after the swap");
  });

  test("frozen evidence that changes between reads fails the proof", async () => {
    const stack = shadow({ unstable_evidence: true });
    expect(failing(await registrationScenario(stack.io, stack.source)))
      .toContain("evidence frozen earlier in the second run is unchanged by every later revision and task link captured in it");
  });

  test("an item missing one of its questions' pins fails the proof", async () => {
    const stack = shadow({ drops_correctness: true });
    expect(failing(await registrationScenario(stack.io, stack.source)))
      .toContain("each first item has exactly its questions, pinned to the selection in force at its capture");
  });

  test("evidence frozen earlier that is no longer ready fails the proof", async () => {
    const stack = shadow({ forgets_evidence: true });
    expect(failing(await registrationScenario(stack.io, stack.source)))
      .toContain("evidence frozen earlier in the second run is unchanged by every later revision and task link captured in it");
  });

  test("a cited file served at another commit than the assessment's fails the proof", async () => {
    const stack = shadow({ wrong_commit: true });
    expect(failing(await registrationScenario(stack.io, stack.source)))
      .toContain("their evidence reads each cited file at the assessed commit, with the content the repository holds there");
  });

  test("an execution created by capture or restart fails the proof", async () => {
    const stack = shadow({ executions: 1 });
    expect(failing(await registrationScenario(stack.io, stack.source))).toContain("capture and collection execute nothing");
  });

  test("the committed selection and the repository are restored even when the stack does not start", async () => {
    const stack = shadow();
    await stack.source.withholdRepository();
    const report = await registrationScenario({ ...stack.io, startStack: async () => err({ operation: "start_stack", entity_id: "x", detail: "down" }) }, stack.source);
    expect(report.status).toBe("failed");
    expect(stack.graders()).toBe(committedText);
    expect(stack.withheld()).toBe(false);
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
