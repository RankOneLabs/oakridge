import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Cause, Workflow, WorkerResult } from "../src/core-client/core-types";
import { decodeEffectInstruction } from "../src/domain/effect-instruction";
import type { RunId } from "../src/domain/primitives";
import { observePullRequest } from "../src/operations/pull-request-observe";
import { decodePullRequestObserveInput } from "../src/operations/pull-request-observe";
import type { OperationRunner } from "../src/operations/runner";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";
import { createProductionComposition } from "../src/runtime/compose";
import { readLatestRevisionId } from "../src/storage/read-store";
import { reportWorker } from "../src/workflows/executor-ingress";
import { runWorkflowId, wakeRun } from "../src/workflows/topology";
import { launch, openAuthority, pinWorkflow, submitter, unitOf, type Authority } from "./authority-fixture";
import { eventually } from "./stub-kbbl";

/**
 * Periodic workers through commit and Postgres (validation spec §3.2, D-V1):
 * a watch pinned to its resolved inputs, replaced when they change; a failed
 * watch retried and its schedule resumed; an unchanged observation publishing
 * nothing. Each attempt is reported as the executor reports it.
 */

let authority: Authority;
beforeAll(async () => { authority = await openAuthority(); });
afterAll(async () => { await authority.close(); });

/** A builder publishing `pr`, and a watch publishing `latest(pr)` once it is published: the shape of `pr_watch`. */
const WATCH: Workflow = {
  workflow: "watch", input: {},
  run: { units: { watch: { stage: "watch", input: {} } }, outcome: {} },
  stages: { watch: { input: {}, artifacts: { pr: { schema: "text" }, observation: { schema: "text" } },
    workers: {
      builder: { kind: "agent", prompts: { initial: "review-loop/write.md" }, inputs: { topic: "\"pr\"" }, creates: ["pr"] },
      observer: { kind: "code", operation: "value.publish", when: "published(pr)", inputs: { value: "latest(pr)" }, every: "1s", creates: ["observation"] },
    },
    done_when: "false", outcome: {} } },
};
const QUERY = { owner: "oakridge-e2e", name: "app", head_owner: "oakridge-e2e", head_branch: "cohort-a", base_branch: "develop",
  pr_url: "https://github.com/oakridge-e2e/app/pull/7" };
const QUERY_SCHEMA = { owner: "ident", name: "ident", head_owner: "ident", head_branch: "text", base_branch: "text", pr_url: "text" };
const PR_STATUS = { state: "enum(open, merged, closed_unmerged)", number: "integer", url: "text", head_sha: "optional(text)", merged_at: "optional(text)" };
/** `pr_watch` alone, its query given at launch. */
const PR_WATCH: Workflow = {
  workflow: "pr_watch", input: { query: QUERY_SCHEMA },
  run: { units: { watch: { stage: "watch", input: { query: "input.query" } } }, outcome: {} },
  stages: { watch: { input: { query: QUERY_SCHEMA },
    artifacts: { pr_state: { schema: PR_STATUS } },
    workers: { pr_watch: { kind: "code", operation: "pull_request.observe", inputs: { query: "input.query" }, every: "1s", creates: ["pr_state"] } },
    done_when: "false", outcome: {} } },
};

interface Attempt { readonly action_id: string; readonly seq: number; readonly cause: Cause; readonly status: { readonly kind: string } }
const attemptsOf = (run_id: RunId, worker: string): Promise<readonly Attempt[]> => authority.db.selectFrom("authority.attempt")
  .select(["action_id", "seq", "cause", "status"]).where("run_id", "=", run_id).where("worker", "=", worker)
  .orderBy("created_at").orderBy("seq").execute();
/** A worker's intents, in the order commit opened their actions. */
async function intentsOf(run_id: RunId, worker: string) {
  const actions = [...new Set((await attemptsOf(run_id, worker)).map((attempt) => attempt.action_id))];
  const rows = await authority.db.selectFrom("authority.effect_intent").select(["action_id", "status", "payload"]).where("run_id", "=", run_id).execute();
  return actions.flatMap((action_id) => rows.filter((row) => row.action_id === action_id).flatMap((row) => {
    const decoded = decodeEffectInstruction(row.payload);
    return decoded.ok ? [{ action_id: row.action_id, status: row.status, instruction: decoded.value }] : [];
  }));
}
const revisionsOf = (run_id: RunId, artifact: string) => authority.db.selectFrom("authority.artifact_revision").select(["id", "body", "by_id"])
  .where("run_id", "=", run_id).where("artifact", "=", artifact).orderBy("created_at").execute();

/** One attempt as the executor carries it: started, its output published (when it has one), ended. Returns any refusal. */
async function runAttempt(run_id: RunId, attempt: { readonly action_id: string; readonly seq: number },
  output: { readonly unit: string; readonly artifact: string; readonly body: unknown } | null, result: WorkerResult = { kind: "succeeded" }): Promise<readonly string[]> {
  const deps = { db: authority.db, core: authority.core, wake: () => undefined };
  const refusals: string[] = [];
  const report = async (input: Parameters<typeof reportWorker>[1]["report"]) => {
    const committed = await reportWorker(deps, { run_id, attempt, report: input });
    if (!committed.ok) throw new Error(committed.error.detail);
    if (committed.value.kind === "rejected") refusals.push(committed.value.reason);
  };
  await report({ kind: "started", session_id: null, publication_secret_hash: null });
  if (output) await report({ kind: "published", ...output,
    predecessor: await readLatestRevisionId(authority.db, { run_id, unit_id: output.unit, artifact: output.artifact }) });
  await report({ kind: "ended", result });
  return refusals;
}

/** Launched WATCH with the builder's `pr` published as "one"; returns the run and its first watch. */
async function watchingOne(): Promise<{ readonly run_id: RunId; readonly unit: string; readonly first: string }> {
  const { bundle_id } = await pinWorkflow(authority, WATCH);
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: {} });
  const unit = unitOf(run_id, "watch");
  const [builder] = await attemptsOf(run_id, "builder");
  if (!builder) throw new Error("launch opened no builder attempt");
  await runAttempt(run_id, builder, { unit, artifact: "pr", body: "one" });
  const [first] = await attemptsOf(run_id, "observer");
  if (!first) throw new Error("publishing pr opened no watch");
  return { run_id, unit, first: first.action_id };
}
/** The operator moves the watch's input: an edit of `pr`. */
async function editPr(run_id: RunId, unit: string, body: string): Promise<void> {
  const predecessor = await readLatestRevisionId(authority.db, { run_id, unit_id: unit, artifact: "pr" });
  const committed = await submitter(authority)({ run_id, event: { kind: "revision_published", unit, artifact: "pr", body, predecessor, subject: null, by: null } });
  if (!committed.ok || committed.value.kind !== "committed") throw new Error(`edit refused: ${JSON.stringify(committed)}`);
}

test("a watch whose input changes is replaced by a watch pinned to the new input, and the old one is stopped", async () => {
  const { run_id, unit, first } = await watchingOne();
  await runAttempt(run_id, { action_id: first, seq: 1 }, { unit, artifact: "observation", body: "one" });
  await editPr(run_id, unit, "two");
  const intents = await intentsOf(run_id, "observer");
  expect(intents.map((intent) => ({ status: intent.status, inputs: intent.instruction.inputs, every: intent.instruction.worker.kind === "code" && intent.instruction.worker.every })))
    .toEqual([{ status: "stop_requested", inputs: { value: "one" }, every: "1s" }, { status: "pending", inputs: { value: "two" }, every: "1s" }]);
});

test("the replacing watch observes the new input, and the replaced watch is refused another attempt", async () => {
  const { run_id, unit, first } = await watchingOne();
  await runAttempt(run_id, { action_id: first, seq: 1 }, { unit, artifact: "observation", body: "one" });
  await editPr(run_id, unit, "two");
  const second = (await attemptsOf(run_id, "observer")).at(-1);
  if (!second) throw new Error("no second watch");
  const late = await runAttempt(run_id, { action_id: first, seq: 2 }, { unit, artifact: "observation", body: "one" });
  await runAttempt(run_id, second, { unit, artifact: "observation", body: "two" });
  expect({ late_start: late[0], observations: (await revisionsOf(run_id, "observation")).map((revision) => revision.body) })
    .toEqual({ late_start: "periodic action is superseded", observations: ["one", "two"] });
});

test("a replacement watch's second attempt keeps its own action identity and sequence in the wanted log", async () => {
  const { run_id, unit, first } = await watchingOne();
  await runAttempt(run_id, { action_id: first, seq: 1 }, { unit, artifact: "observation", body: "one" });
  await editPr(run_id, unit, "two");
  const replacement = (await attemptsOf(run_id, "observer")).at(-1);
  if (!replacement) throw new Error("the edit opened no replacement watch");
  await runAttempt(run_id, replacement, { unit, artifact: "observation", body: "two" });
  const refusals = await runAttempt(run_id, { action_id: replacement.action_id, seq: 2 },
    { unit, artifact: "observation", body: "two" });
  if (refusals.length) throw new Error(`second attempt refused: ${refusals.join(", ")}`);
  const attempts = await attemptsOf(run_id, "observer");
  const latest = await authority.db.selectFrom("authority.wanted_log as wanted")
    .innerJoin("authority.event as event", "event.id", "wanted.event_id")
    .select("wanted.actions").where("wanted.run_id", "=", run_id).where("wanted.unit_id", "=", unit)
    .orderBy("event.created_at", "desc").orderBy("event.id", "desc").executeTakeFirstOrThrow();
  const worker = latest.actions.find((item) => item.worker === "observer");
  expect({ wanted_count: latest.actions.length, action_id: worker?.action_id, attempt_seq: worker?.attempt_seq,
    distinct_from_first: worker?.action_id !== first,
    committed_attempt: attempts.some((attempt) => attempt.action_id === worker?.action_id && attempt.seq === worker?.attempt_seq) })
    .toEqual({ wanted_count: 1, action_id: replacement.action_id, attempt_seq: 2,
      distinct_from_first: true, committed_attempt: true });
});

test("a failed watch, retried, succeeds on an unchanged observation and its schedule resumes under a new watch", async () => {
  const { run_id, unit, first } = await watchingOne();
  await runAttempt(run_id, { action_id: first, seq: 1 }, { unit, artifact: "observation", body: "one" });
  await runAttempt(run_id, { action_id: first, seq: 2 }, null, { kind: "failed", code: "operation_unavailable", detail: "forge down" });
  const retried = await submitter(authority)({ run_id, event: { kind: "retry_requested", unit, worker: "observer" } });
  if (!retried.ok || retried.value.kind !== "committed") throw new Error(`retry refused: ${JSON.stringify(retried)}`);
  const retry = (await attemptsOf(run_id, "observer")).at(-1);
  if (!retry) throw new Error("the retry opened no attempt");
  await runAttempt(run_id, retry, { unit, artifact: "observation", body: "one" });
  const resumed = (await attemptsOf(run_id, "observer")).at(-1);
  if (!resumed) throw new Error("no watch after the retry");
  await runAttempt(run_id, resumed, { unit, artifact: "observation", body: "one" });
  await runAttempt(run_id, { action_id: resumed.action_id, seq: 2 }, { unit, artifact: "observation", body: "one" });
  const attempts = await attemptsOf(run_id, "observer");
  const intents = await intentsOf(run_id, "observer");
  expect({
    attempts: attempts.map((attempt) => [attempt.cause.kind, attempt.seq, attempt.status.kind]),
    resumed_replaces_retry: resumed.cause.kind === "periodic" && resumed.cause.replaces === retry.action_id,
    repeats: intents.map((intent) => intent.instruction.worker.kind === "code" && intent.instruction.worker.every),
    observations: (await revisionsOf(run_id, "observation")).length,
  }).toEqual({
    attempts: [["periodic", 1, "succeeded"], ["periodic", 2, "failed"], ["retry", 1, "succeeded"], ["periodic", 1, "succeeded"], ["periodic", 2, "succeeded"]],
    resumed_replaces_retry: true,
    repeats: ["1s", null, "1s"],
    observations: 1,
  });
});

test("an unchanged pull request observation publishes no new revision and its attempt succeeds", async () => {
  const { bundle_id } = await pinWorkflow(authority, PR_WATCH);
  const { run_id } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { query: QUERY } });
  const unit = unitOf(run_id, "watch");
  const pull_request = { number: 7, html_url: QUERY.pr_url, state: "open", merged_at: null,
    head: { ref: QUERY.head_branch, sha: "abc123", repo: { full_name: `${QUERY.head_owner}/app` } }, base: { ref: QUERY.base_branch } };
  const reader = new GithubPullRequestReader({ token: "test" }, (async () => Response.json(pull_request)) as unknown as typeof fetch);
  const [watch] = await attemptsOf(run_id, "pr_watch");
  if (!watch) throw new Error("launch opened no watch");
  for (const seq of [1, 2]) {
    const observed = await observePullRequest(reader, { query: QUERY });
    if (observed.kind !== "succeeded") throw new Error(`observation failed: ${JSON.stringify(observed)}`);
    await runAttempt(run_id, { action_id: watch.action_id, seq }, { unit, artifact: "pr_state", body: observed.body });
    await Bun.sleep(5);
  }
  const attempts = await attemptsOf(run_id, "pr_watch");
  expect({ revisions: (await revisionsOf(run_id, "pr_state")).length, attempts: attempts.map((attempt) => attempt.status.kind) })
    .toEqual({ revisions: 1, attempts: ["succeeded", "succeeded"] });
});

test("a transient pr_watch outage backs off and observes a merge, while a terminal failure settles", async () => {
  const live = await openAuthority();
  const { digest } = await pinWorkflow(live, PR_WATCH);
  const calls: number[] = [];
  const operation_runner: OperationRunner = { async run(call) {
    const input = decodePullRequestObserveInput(call.inputs);
    if (call.operation !== "pull_request.observe" || !input) throw new Error("unexpected operation call");
    if (input.query.head_branch === "terminal") return { kind: "failed", code: "pull_request_mismatch", detail: "repository deleted" };
    calls.push(Date.now());
    if (calls.length <= 3) return { kind: "unavailable", detail: "forge unavailable" };
    return { kind: "succeeded", body: { state: "merged", number: 7, url: QUERY.pr_url,
      head_sha: "abc123", merged_at: "2026-10-15T12:00:00Z" } };
  } };
  const composition = await createProductionComposition({ database_url: live.url, host: "127.0.0.1", operation_runner,
    timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, wake_timeout_seconds: 5, carrier_max_iterations: 8 } });
  try {
    const start = async (head_branch: string): Promise<RunId> => {
      const response = await composition.app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ request_id: crypto.randomUUID(), digest, input: { query: { ...QUERY, head_branch } } }) });
      if (response.status !== 201) throw new Error(`launch failed: ${await response.text()}`);
      return (await response.json() as { run_id: RunId }).run_id;
    };
    const transient = await start("transient");
    await eventually("merged pull request observation", async () =>
      (await live.db.selectFrom("authority.artifact_revision").select("body").where("run_id", "=", transient)
        .where("artifact", "=", "pr_state").executeTakeFirst())?.body ?? null);
    const first_attempt = await eventually("merged watch attempt ended", async () => {
      const row = await live.db.selectFrom("authority.attempt").select("status").where("run_id", "=", transient)
        .where("worker", "=", "pr_watch").where("seq", "=", 1).executeTakeFirst();
      return row?.status.kind === "succeeded" ? row : null;
    });
    const transient_intent = await live.db.selectFrom("authority.effect_intent").select("status")
      .where("run_id", "=", transient).executeTakeFirstOrThrow();
    expect({ first_attempt: first_attempt.status.kind, alive: transient_intent.status,
      retried: calls.length >= 4 })
      .toEqual({ first_attempt: "succeeded", alive: "acknowledged", retried: true });
    expect(calls[3]! - calls[2]!).toBeGreaterThanOrEqual(40);

    const terminal = await start("terminal");
    await eventually("terminal watch settlement", async () => {
      const intent = await live.db.selectFrom("authority.effect_intent").select("status").where("run_id", "=", terminal).executeTakeFirst();
      return intent?.status === "failed" ? true : null;
    });
    const terminal_attempts = await live.db.selectFrom("authority.attempt").select("status")
      .where("run_id", "=", terminal).where("worker", "=", "pr_watch").execute();
    expect(terminal_attempts.map((attempt) => attempt.status.kind)).toEqual(["failed"]);
  } finally { await composition.close(); await live.close(); }
});

test("a wake sent during carrier dispatch advances the run before its wake timeout", async () => {
  const live = await openAuthority();
  const { digest } = await pinWorkflow(live, PR_WATCH);
  const composition = await createProductionComposition({ database_url: live.url, host: "127.0.0.1",
    operation_runner: { async run() { return { kind: "failed", code: "pull_request_mismatch", detail: "terminal" }; } },
    timing: { wake_timeout_seconds: 20 } });
  const real_start = DBOS.startWorkflow.bind(DBOS);
  let release_dispatch = (): void => undefined;
  const dispatch_released = new Promise<void>((resolve) => { release_dispatch = resolve; });
  let signal_dispatch = (): void => undefined;
  const dispatch_entered = new Promise<void>((resolve) => { signal_dispatch = resolve; });
  let held = false;
  const start = spyOn(DBOS, "startWorkflow").mockImplementation(((workflow: unknown, options: { workflowID?: string }) => {
    const launch = real_start(workflow as never, options as never);
    if (!held && options.workflowID?.includes("@")) {
      held = true;
      return async (...args: unknown[]) => {
        signal_dispatch();
        await dispatch_released;
        return (launch as (...args: unknown[]) => Promise<unknown>)(...args);
      };
    }
    return launch;
  }) as never);
  try {
    const response = await composition.app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: crypto.randomUUID(), digest, input: { query: QUERY } }) });
    if (response.status !== 201) throw new Error(`launch failed: ${await response.text()}`);
    const { run_id } = await response.json() as { run_id: RunId };
    await dispatch_entered;
    const before = await DBOS.listWorkflowSteps(runWorkflowId(run_id)) ?? [];
    expect(before.filter((step) => step.name === "oakridgeAdvanceRun")).toHaveLength(1);
    await wakeRun(run_id);
    const released_at = Date.now();
    release_dispatch();
    await eventually("run advance after queued wake", async () => {
      const steps = await DBOS.listWorkflowSteps(runWorkflowId(run_id)) ?? [];
      return steps.filter((step) => step.name === "oakridgeAdvanceRun").length >= 2 ? true : null;
    }, 5_000);
    expect(Date.now() - released_at).toBeLessThan(5_000);
  } finally { release_dispatch(); start.mockRestore(); await composition.close(); await live.close(); }
});
