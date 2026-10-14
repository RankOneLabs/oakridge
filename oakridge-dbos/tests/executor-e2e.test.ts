import { afterAll, beforeAll, expect, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Workflow } from "../src/core-client/core-types";
import { createProductionComposition } from "../src/runtime/compose";
import { intentWorkflowId } from "../src/workflows/topology";
import { openDatabase, type Database } from "../src/storage/database";
import { launchRunId } from "../src/storage/commit";
import { selectCollectionKey, selectUnitKey } from "../src/projections/unit-label";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { sampleWorkflow, scratchDatabase } from "./authority-fixture";
import { eventually, startStubKbbl, type AgentScript, type StubKbbl, type StubTurn } from "./stub-kbbl";

/**
 * The executor end to end (part 1 §11 I1–I3, rescue spec §4.3): the
 * production composition, served over HTTP, carrying the samples against a
 * stub kbbl whose agents publish through the real publish route.
 */

const scripts = new Map<string, AgentScript>();
const runOf = (turn: StubTurn): string => /of run `([^`]+)`/.exec(turn.preamble)?.[1] ?? "";
const workerOf = (turn: StubTurn): string => /worker `([^`]+)`/.exec(turn.preamble)?.[1] ?? "";
const unitOf = (turn: StubTurn): string => /on unit `([^`]+)`/.exec(turn.preamble)?.[1] ?? "";

let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
let db: Database;
let stub: StubKbbl;
let server: ReturnType<typeof Bun.serve>;
let composition: Awaited<ReturnType<typeof createProductionComposition>>;
let base_url: string;
const workdir = mkdtempSync(resolve(tmpdir(), "oakridge-e2e-agents-"));

beforeAll(async () => {
  scratch = await scratchDatabase();
  db = openDatabase(scratch.url);
  await migrateEmptyDatabase(db);
  stub = startStubKbbl(async (turn) => {
    const script = scripts.get(runOf(turn));
    if (!script) throw new Error(`no script for ${runOf(turn)}`);
    return script(turn);
  });
  // Agents publish to the backend over HTTP, so it listens before it is composed.
  let handler: (request: Request) => Response | Promise<Response> = () => new Response("starting", { status: 503 });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => handler(request) });
  base_url = `http://127.0.0.1:${server.port}`;
  composition = await createProductionComposition({ database_url: scratch.url, host: "127.0.0.1",
    executor: { kbbl_base_url: stub.url, publication_key: "e2e-key", publish_base_url: base_url, agent_workdir: workdir, github_token: null },
    // A small carrier bound, so sessions and watches here also run across carrier generations.
    timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, max_observe_unavailable_attempts: 5, wake_timeout_seconds: 0.5,
      carrier_max_iterations: 2 } });
  handler = composition.app.fetch;
}, 60_000);
afterAll(async () => {
  await composition.close();
  server.stop(true);
  stub.stop();
  await db.destroy();
  await scratch.drop();
  rmSync(workdir, { recursive: true, force: true });
});

const api = async (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${base_url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const segment = encodeURIComponent;
async function launch(workflow: Workflow, input: unknown, script: AgentScript): Promise<string> {
  const pinned = await api("POST", "/api/definitions", workflow);
  const { digest } = await pinned.json() as { readonly digest: string };
  const request_id = crypto.randomUUID();
  scripts.set(launchRunId(request_id), script);
  const launched = await api("POST", "/api/runs", { request_id, digest, input });
  if (launched.status !== 201) throw new Error(`launch refused: ${await launched.text()}`);
  return (await launched.json() as { readonly run_id: string }).run_id;
}
const decide = (run_id: string, unit: string, decision: string, target: string, payload: unknown) =>
  api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit)}/reviews/editor/decide`, { request_id: crypto.randomUUID(), decision, target, payload });
const retry = (run_id: string, unit: string, worker: string) =>
  api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit)}/workers/${worker}/retry`, { request_id: crypto.randomUUID() });

const runStatus = async (run_id: string): Promise<string> =>
  (await db.selectFrom("authority.run").select("status").where("id", "=", run_id).executeTakeFirstOrThrow()).status.kind;
const revisions = (run_id: string, artifact: string) => db.selectFrom("authority.artifact_revision").select(["id", "body", "subject", "unit_id"])
  .where("run_id", "=", run_id).where("artifact", "=", artifact).orderBy("created_at").orderBy("id").execute();
const attempts = (run_id: string, worker: string) => db.selectFrom("authority.attempt").select(["action_id", "seq", "status", "kbbl_session_id", "unit_id"])
  .where("run_id", "=", run_id).where("worker", "=", worker).orderBy("created_at").orderBy("action_id").execute();
const units = async (run_id: string) => (await db.selectFrom("authority.unit").select(["id", "parent_id", "declaration", "status"]).where("run_id", "=", run_id).execute())
  .map((unit) => ({ ...unit, unit_key: selectUnitKey(unit), collection_key: selectCollectionKey(unit) }));
const sessionsOfRun = (run_id: string, worker?: string) =>
  stub.sessionsFor((session) => session.spec.initial_prompt.includes(`of run \`${run_id}\``) && (worker === undefined || session.spec.initial_prompt.includes(`worker \`${worker}\``)));

/** Sample A's agents: the critic critiques, the writer drafts, revises to an empty body once, then fixes it. */
function reviewLoopAgents(observed: { revise_tasks: string[] }): AgentScript {
  return async (turn) => {
    if (workerOf(turn) === "critic") {
      // The same critique each time: a new subject is a new revision.
      const published = await turn.publish("critique", { notes: ["tighten it"] }, { subject: turn.subject(), predecessor: turn.predecessor("critique") });
      return published.ok ? "succeeded" : "failed";
    }
    if (turn.task.includes("Write a first draft")) {
      await turn.publish("draft", { title: "Oakridge", body: "A long first draft about Oakridge." });
      return "succeeded";
    }
    observed.revise_tasks.push(turn.task);
    if (!turn.task.includes("body is empty")) {
      // The revise publishes an empty body, which the validator refuses, and the session then fails.
      await turn.publish("draft", { title: "Oakridge", body: "" }, { predecessor: turn.predecessor("draft") });
      return "failed";
    }
    await turn.publish("draft", { title: "Oakridge", body: "Short." }, { predecessor: turn.predecessor("draft") });
    return "succeeded";
  };
}

test("I1: sample A end to end through HTTP; the editor's feedback reaches the writer's revise, which resumes its session", async () => {
  const observed = { revise_tasks: [] as string[] };
  const run_id = await launch(sampleWorkflow("review-loop"), { topic: "Oakridge" }, reviewLoopAgents(observed));
  const unit = `${run_id}/document`;
  const [r1] = await eventually("r1 critiqued", async () => {
    const [drafts, critiques] = await Promise.all([revisions(run_id, "draft"), revisions(run_id, "critique")]);
    return drafts.length === 1 && critiques.some((critique) => critique.subject === drafts[0]!.id) ? drafts : null;
  });
  expect((await decide(run_id, unit, "request_changes", r1!.id, { feedback: "shorter" })).status).toBe(201);
  await eventually("the revise to fail", async () => (await attempts(run_id, "writer")).some((attempt) => attempt.status.kind === "failed"));
  expect(await runStatus(run_id)).toBe("active");
  expect((await retry(run_id, unit, "writer")).status).toBe(201);
  const r3 = await eventually("r3 critiqued", async () => {
    const [drafts, critiques] = await Promise.all([revisions(run_id, "draft"), revisions(run_id, "critique")]);
    const latest = drafts.at(-1);
    return drafts.length === 3 && critiques.some((critique) => critique.subject === latest?.id) ? latest : null;
  });
  expect((await decide(run_id, unit, "approve", r3.id, {})).status).toBe(201);
  await eventually("the run to finish", async () => await runStatus(run_id) === "done");

  const writer_attempts = await attempts(run_id, "writer");
  const writer_sessions = sessionsOfRun(run_id, "writer");
  expect({
    feedback_reached_revise: observed.revise_tasks[0]?.includes("shorter"),
    validator_feedback_reached_retry: observed.revise_tasks[1]?.includes("body is empty"),
    drafts: (await revisions(run_id, "draft")).map((revision) => (revision.body as { body: string }).body),
    writer_attempts: writer_attempts.map((attempt) => attempt.status.kind),
    one_writer_session: new Set(writer_attempts.map((attempt) => attempt.kbbl_session_id)).size,
    writer_sessions_created: writer_sessions.length,
    writer_inputs: writer_sessions[0]?.inputs.length,
  }).toEqual({ feedback_reached_revise: true, validator_feedback_reached_retry: true, drafts: ["A long first draft about Oakridge.", "", "Short."],
    writer_attempts: ["succeeded", "failed", "succeeded"], one_writer_session: 1, writer_sessions_created: 1, writer_inputs: 3 });
}, 90_000);

test("a revise under session: fresh opens a new session whose first input carries the handoff block", async () => {
  const workflow = sampleWorkflow("review-loop");
  const writer = workflow.stages.document!.workers.writer!;
  if (writer.kind !== "agent") throw new Error("writer is an agent");
  const fresh: Workflow = { ...workflow, workflow: "review_loop_fresh", stages: { document: { ...workflow.stages.document!,
    workers: { ...workflow.stages.document!.workers, writer: { ...writer, session: "fresh" } } } } };
  const run_id = await launch(fresh, { topic: "Oakridge" }, async (turn) => {
    if (workerOf(turn) === "critic") {
      await turn.publish("critique", { notes: ["ok"] }, { subject: turn.subject(), predecessor: turn.predecessor("critique") });
      return "succeeded";
    }
    await turn.publish("draft", { title: "Oakridge", body: turn.task.includes("Write a first draft") ? "A long first draft." : "Short." },
      { predecessor: turn.predecessor("draft") });
    return "succeeded";
  });
  const unit = `${run_id}/document`;
  const [r1] = await eventually("r1 critiqued", async () => {
    const [drafts, critiques] = await Promise.all([revisions(run_id, "draft"), revisions(run_id, "critique")]);
    return drafts.length === 1 && critiques.length === 1 ? drafts : null;
  });
  expect((await decide(run_id, unit, "request_changes", r1!.id, { feedback: "shorter" })).status).toBe(201);
  const r2 = await eventually("r2", async () => (await revisions(run_id, "draft"))[1]);
  await eventually("r2 critiqued", async () => (await revisions(run_id, "critique")).some((critique) => critique.subject === r2.id));
  expect((await decide(run_id, unit, "approve", r2.id, {})).status).toBe(201);
  await eventually("the run to finish", async () => await runStatus(run_id) === "done");

  const sessions = sessionsOfRun(run_id, "writer");
  const revise_input = sessions[1]?.inputs[0]?.text ?? "";
  expect({ sessions: sessions.length, keys: new Set(sessions.map((session) => session.session_key)).size, inputs: sessions.map((session) => session.inputs.length),
    starts_with_handoff: revise_input.startsWith("## Handoff"), hands_off_r1: revise_input.includes(r1!.id), hands_off_feedback: revise_input.includes("shorter") })
    .toEqual({ sessions: 2, keys: 2, inputs: [1, 1], starts_with_handoff: true, hands_off_r1: true, hands_off_feedback: true });
}, 90_000);

// ---------------------------------------------------------------- sample B --

/** A temporary repository the code worker prepares: one commit, and a GitHub push remote it never reaches. */
async function temporaryRepository(): Promise<{ readonly path: string; readonly head: string; remove(): void }> {
  const path = mkdtempSync(resolve(tmpdir(), "oakridge-e2e-repo-"));
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
    return stdout.trim();
  };
  await git("init", "-q", "-b", "main");
  await git("-c", "user.email=e2e@oakridge.test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "base");
  await git("remote", "add", "origin", "git@github.com:oakridge-e2e/fan-out.git");
  return { path, head: await git("rev-parse", "HEAD"), remove: () => rmSync(path, { recursive: true, force: true }) };
}
const ITEMS = [{ key: "a", text: "alpha", after: [] }, { key: "b", text: "beta", after: [] }, { key: "c", text: "gamma", after: ["a"] }, { key: "d", text: "delta", after: [] }];
const itemOf = (turn: StubTurn): string => unitOf(turn).split("/").at(-1) ?? "";
/** An item agent that publishes its result once `release` lets it, recording when it started and finished. */
function itemAgents(timeline: { readonly started: Map<string, number>; readonly finished: Map<string, number> },
  release: (item: string) => Promise<TurnEnd>): AgentScript {
  return async (turn) => {
    const item = itemOf(turn);
    timeline.started.set(item, Date.now());
    const end = await release(item);
    if (end === "succeeded") await turn.publish("result", `done: ${item}`);
    timeline.finished.set(item, Date.now());
    return end;
  };
}
type TurnEnd = "succeeded" | "failed";
const memberUnit = async (run_id: string, key: string): Promise<string> =>
  (await units(run_id)).find((unit) => unit.collection_key === key)?.id ?? "";

test("I2: sample B prepares a temporary repository and runs every item in a worktree of it, two at a time, c after a", async () => {
  const repo = await temporaryRepository();
  try {
    const timeline = { started: new Map<string, number>(), finished: new Map<string, number>() };
    const run_id = await launch(sampleWorkflow("fan-out"), { repository: { repository_path: repo.path, expected_head: null }, items: ITEMS },
      itemAgents(timeline, async () => { await Bun.sleep(300); return "succeeded"; }));
    await eventually("the run to finish", async () => await runStatus(run_id) === "done", 60_000);
    const item_sessions = sessionsOfRun(run_id, "worker");
    const [workspace] = await revisions(run_id, "workspace");
    expect({
      workspace: workspace?.body,
      items: item_sessions.length,
      worktrees: item_sessions.map((session) => [session.spec.workdir, session.spec.worktree?.base_ref]),
      distinct_branches: new Set(item_sessions.map((session) => session.spec.worktree?.branch_name)).size,
      c_after_a: (timeline.started.get("c") ?? 0) >= (timeline.finished.get("a") ?? Infinity),
      at_most_two: stub.max_running() <= 2,
    }).toEqual({ workspace: { repository_path: repo.path, push_remote_owner: "oakridge-e2e", head: repo.head }, items: 4,
      worktrees: Array.from({ length: 4 }, () => [repo.path, repo.head]), distinct_branches: 4, c_after_a: true, at_most_two: true });
  } finally { repo.remove(); }
}, 90_000);

test("I3: cancelling mid-flight stops every live session and cancels every unit", async () => {
  const repo = await temporaryRepository();
  try {
    const timeline = { started: new Map<string, number>(), finished: new Map<string, number>() };
    let released = false;
    const run_id = await launch(sampleWorkflow("fan-out"), { repository: { repository_path: repo.path, expected_head: null }, items: ITEMS },
      itemAgents(timeline, async () => { await eventually("release", async () => released, 60_000); return "succeeded"; }));
    await eventually("two item sessions running", async () => timeline.started.size === 2);
    expect((await api("POST", `/api/runs/${segment(run_id)}/cancel`, { request_id: crypto.randomUUID() })).status).toBe(201);
    await eventually("every session stopped", async () => {
      const sessions = sessionsOfRun(run_id, "worker");
      return sessions.length === 2 && sessions.every((session) => session.closes.length > 0);
    });
    released = true;
    const statuses = (await units(run_id)).map((unit) => [unit.unit_key, unit.collection_key, unit.status.kind]);
    expect({ run: await runStatus(run_id), not_cancelled: statuses.filter(([key, , status]) => key !== "prepare" && status !== "cancelled") })
      .toEqual({ run: "cancelled", not_cancelled: [] });
  } finally { repo.remove(); }
}, 90_000);

test("I3: a failed item stalls holding its slot while its siblings run to completion, and a retry completes the run", async () => {
  const repo = await temporaryRepository();
  try {
    const timeline = { started: new Map<string, number>(), finished: new Map<string, number>() };
    let b_tries = 0;
    const run_id = await launch(sampleWorkflow("fan-out"), { repository: { repository_path: repo.path, expected_head: null }, items: ITEMS },
      itemAgents(timeline, async (item) => item === "b" && ++b_tries === 1 ? "failed" : "succeeded"));
    await eventually("a, c and d to finish", async () => {
      const done = (await units(run_id)).filter((unit) => unit.status.kind === "done").map((unit) => unit.collection_key);
      return ["a", "c", "d"].every((key) => done.includes(key));
    });
    await Bun.sleep(500);
    const b = await memberUnit(run_id, "b");
    const stalled = await units(run_id);
    expect({ run: await runStatus(run_id), b: stalled.find((unit) => unit.id === b)?.status.kind,
      work: stalled.find((unit) => unit.unit_key === "work" && unit.collection_key === null)?.status.kind, b_tries })
      .toEqual({ run: "active", b: "active", work: "active", b_tries: 1 });
    expect((await retry(run_id, b, "worker")).status).toBe(201);
    await eventually("the run to finish", async () => await runStatus(run_id) === "done", 60_000);
    // b completes on its retry's publish, so the retry's session is stopped and its attempt ended as stopped.
    expect(await eventually("b's retry to end", async () => {
      const ended = (await attempts(run_id, "worker")).filter((attempt) => attempt.unit_id === b).map((attempt) => attempt.status);
      return ended.at(-1)?.kind === "running" ? null : ended.map((status) => status.kind === "failed" ? status.code : status.kind);
    })).toEqual(["session_failed", "attempt_stopped"]);
  } finally { repo.remove(); }
}, 90_000);

test("K3: sample A with every key renamed runs end to end, so a new workflow needs only config", async () => {
  const sample = sampleWorkflow("review-loop");
  const renamed: Workflow = {
    workflow: "renamed_loop", input: sample.input,
    run: { units: { essay: { stage: "essay_stage", input: { topic: "input.topic" } } }, outcome: { draft: "essay.outcome.draft" } },
    stages: { essay_stage: {
      input: { topic: "text" },
      artifacts: {
        paper: { schema: { title: "text", body: "text" }, validate: [{ check: "len(paper.body) > 0", message: "body is empty" }] },
        remarks: { schema: { notes: "list(text)" } },
      },
      workers: {
        author: { kind: "agent", prompts: { initial: "review-loop/write.md", revise: "review-loop/revise.md" },
          inputs: { topic: "input.topic", critique: "latest(remarks)" }, creates: ["paper"] },
        reader: { kind: "agent", prompts: { review: "review-loop/critique.md" }, reviews: "paper", creates: ["remarks"], inputs: {} },
      },
      reviews: { chief: { of: "paper", by: "operator", prompt: "review-loop/editor.md",
        inputs: { topic: "input.topic", draft: "latest(paper)", critique: "latest(remarks)" },
        decisions: { accept: { effect: "approve", label: "Accept" } } } },
      done_when: "approved(paper)", outcome: { draft: "latest(paper)" },
    } },
  };
  const run_id = await launch(renamed, { topic: "Oakridge" }, async (turn) => {
    if (workerOf(turn) === "reader") {
      await turn.publish("remarks", { notes: ["read"] }, { subject: turn.subject(), predecessor: turn.predecessor("remarks") });
      return "succeeded";
    }
    await turn.publish("paper", { title: "Oakridge", body: "A paper." }, { predecessor: turn.predecessor("paper") });
    return "succeeded";
  });
  const unit = `${run_id}/essay`;
  const [paper] = await eventually("the paper read", async () => {
    const [papers, remarks] = await Promise.all([revisions(run_id, "paper"), revisions(run_id, "remarks")]);
    return papers.length === 1 && remarks.length === 1 ? papers : null;
  });
  const decided = await api("POST", `/api/runs/${segment(run_id)}/units/${segment(unit)}/reviews/chief/decide`,
    { request_id: crypto.randomUUID(), decision: "accept", target: paper!.id, payload: {} });
  expect(decided.status).toBe(201);
  await eventually("the run to finish", async () => await runStatus(run_id) === "done");
}, 90_000);

test("a periodic code worker repeats under one intent across carrier generations, publishes only a changed value, and stops with its run", async () => {
  const repo = await temporaryRepository();
  try {
    const periodic: Workflow = {
      workflow: "watch_head", input: { repository_path: "repo_path", expected_head: "optional(text)" },
      run: { units: { watch: { stage: "watch", input: { repository_path: "input.repository_path", expected_head: "input.expected_head" } } }, outcome: {} },
      stages: { watch: { input: { repository_path: "repo_path", expected_head: "optional(text)" },
        artifacts: { workspace: { schema: { repository_path: "repo_path", push_remote_owner: "ident", head: "ident" } } },
        workers: { prepare: { kind: "code", operation: "repository.prepare", every: "1s", creates: ["workspace"],
          inputs: { repository_path: "input.repository_path", expected_head: "input.expected_head" } } },
        done_when: "false", outcome: {} } },
    };
    const run_id = await launch(periodic, { repository_path: repo.path, expected_head: null }, async () => "failed");
    const ran = async (count: number) => eventually(`${count} runs`, async () =>
      (await attempts(run_id, "prepare")).filter((attempt) => attempt.status.kind === "succeeded").length >= count, 20_000);
    await ran(2);
    const unchanged = (await revisions(run_id, "workspace")).length;
    const child = Bun.spawn(["git", "-C", repo.path, "-c", "user.email=e2e@oakridge.test", "-c", "user.name=e2e", "-c", "commit.gpgsign=false",
      "commit", "-q", "--allow-empty", "-m", "next"]);
    await child.exited;
    const moved = await eventually("the new head published", async () => {
      const heads = (await revisions(run_id, "workspace")).map((revision) => (revision.body as { head: string }).head);
      return heads.length === 2 ? heads : null;
    }, 20_000);
    expect((await api("POST", `/api/runs/${segment(run_id)}/cancel`, { request_id: crypto.randomUUID() })).status).toBe(201);
    const intents = await eventually("the intent to settle", async () => {
      const rows = await db.selectFrom("authority.effect_intent").select(["status"]).where("run_id", "=", run_id).execute();
      return rows.every((row) => row.status === "stopped") ? rows : null;
    }, 20_000);
    const runs_after_stop = (await attempts(run_id, "prepare")).length;
    await Bun.sleep(2_500);
    const intent = await db.selectFrom("authority.effect_intent").select("id").where("run_id", "=", run_id).executeTakeFirstOrThrow();
    const carriers = await DBOS.listWorkflows({ workflowName: "oakridgeEffectWorkflow", workflow_id_prefix: intentWorkflowId(intent.id) });
    expect({ unchanged, moved: moved[0] !== moved[1] && moved[0] === repo.head, intents: intents.length,
      quiet_after_stop: (await attempts(run_id, "prepare")).length === runs_after_stop, has_rolled_over: carriers.length > 1 })
      .toEqual({ unchanged: 1, moved: true, intents: 1, quiet_after_stop: true, has_rolled_over: true });
  } finally { repo.remove(); }
}, 90_000);

test("a watch whose input changes is carried by a new intent on the new input, and the replaced one stops", async () => {
  // The shape of pr_watch: a builder publishes `pr`, a watch observes `latest(pr)`; a replacement PR moves its input.
  const watch_pr: Workflow = {
    workflow: "watch_pr", input: {},
    run: { units: { watch: { stage: "watch", input: {} } }, outcome: {} },
    stages: { watch: { input: {}, artifacts: { pr: { schema: "text" }, observation: { schema: "text" } },
      workers: {
        builder: { kind: "agent", prompts: { initial: "review-loop/write.md", revise: "review-loop/revise.md" }, inputs: { topic: "\"pr\"" }, creates: ["pr"] },
        observer: { kind: "code", operation: "value.publish", when: "published(pr)", inputs: { value: "latest(pr)" }, every: "1s", creates: ["observation"] },
      },
      reviews: { editor: { of: "pr", by: "operator", prompt: "review-loop/editor.md", inputs: { topic: "\"pr\"", draft: "latest(pr)", critique: "latest(pr)" },
        decisions: { request_changes: { effect: "request_changes", label: "Replace the PR", fields: { feedback: "Why?" } } } } },
      done_when: "false", outcome: {} } },
  };
  const run_id = await launch(watch_pr, {}, async (turn) => {
    const published = await turn.publish("pr", turn.predecessor("pr") === null ? "one" : "two", { predecessor: turn.predecessor("pr") });
    return published.ok ? "succeeded" : "failed";
  });
  const unit = `${run_id}/watch`;
  await eventually("the first PR observed", async () => (await attempts(run_id, "observer")).some((attempt) => attempt.status.kind === "succeeded"), 20_000);
  expect((await decide(run_id, unit, "request_changes", `${unit}:pr:1`, { feedback: "Open a new PR." })).status).toBe(201);
  const observed = await eventually("the new PR observed", async () => {
    const bodies = (await revisions(run_id, "observation")).map((revision) => revision.body);
    return bodies.length === 2 ? bodies : null;
  }, 20_000);
  const watches = await eventually("the replaced watch to stop", async () => {
    const rows = await db.selectFrom("authority.effect_intent").select(["action_id", "status"]).where("run_id", "=", run_id).execute();
    const actions = [...new Set((await attempts(run_id, "observer")).map((attempt) => attempt.action_id))];
    const statuses = actions.map((action) => rows.find((row) => row.action_id === action)?.status);
    return statuses[0] === "stopped" ? statuses : null;
  }, 20_000);
  expect((await api("POST", `/api/runs/${segment(run_id)}/cancel`, { request_id: crypto.randomUUID() })).status).toBe(201);
  expect({ observed, watches }).toEqual({ observed: ["one", "two"], watches: ["stopped", "acknowledged"] });
}, 90_000);

test("a revise under session: resume revives its ended session and continues it", async () => {
  const run_id = await launch(sampleWorkflow("review-loop"), { topic: "Oakridge" }, async (turn) => {
    if (workerOf(turn) === "critic") { await turn.publish("critique", { notes: ["ok"] }, { subject: turn.subject(), predecessor: turn.predecessor("critique") }); return "succeeded"; }
    await turn.publish("draft", { title: "Oakridge", body: turn.task.includes("Write a first draft") ? "A long first draft." : "Short." },
      { predecessor: turn.predecessor("draft") });
    return "succeeded";
  });
  const unit = `${run_id}/document`;
  const [r1] = await eventually("r1 critiqued", async () => {
    const [drafts, critiques] = await Promise.all([revisions(run_id, "draft"), revisions(run_id, "critique")]);
    return drafts.length === 1 && critiques.length === 1 ? drafts : null;
  });
  // The writer's session ends between attempts, as kbbl ends an idle one or an operator closes it. Only once the
  // executor has seen the first turn succeed: ending it earlier fails that attempt as closed mid-task.
  await eventually("the writer's first attempt to succeed", async () =>
    (await attempts(run_id, "writer")).some((attempt) => attempt.status.kind === "succeeded"));
  const [writer] = sessionsOfRun(run_id, "writer");
  writer!.status = "ended";
  expect((await decide(run_id, unit, "request_changes", r1!.id, { feedback: "shorter" })).status).toBe(201);
  const r2 = await eventually("r2", async () => (await revisions(run_id, "draft"))[1]);
  const [revived] = sessionsOfRun(run_id, "writer");
  expect({ sessions: sessionsOfRun(run_id, "writer").length, same: revived === writer, live: revived?.status, inputs: revived?.inputs.length, r2: (r2.body as { body: string }).body })
    .toEqual({ sessions: 1, same: true, live: "live", inputs: 2, r2: "Short." });
}, 90_000);
