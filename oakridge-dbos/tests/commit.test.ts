import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "kysely";
import { CoreClient } from "../src/core-client/client";
import { decodeEffectInstruction } from "../src/domain/effect-instruction";
import type { Workflow } from "../src/core-client/core-types";
import type { DefinitionBundleId, ProjectId, RunId } from "../src/domain/primitives";
import { requestDigest } from "../src/storage/commit";
import { listRuns } from "../src/storage/read-store";
import { actionOf, executor, launch, OPERATOR, openAuthority, pinSample, pinWorkflow, sampleWorkflow, submitter, unitOf, type Authority } from "./authority-fixture";

let authority: Authority;
let bundle_id: DefinitionBundleId;
beforeAll(async () => {
  authority = await openAuthority();
  ({ bundle_id } = await pinSample(authority));
});
afterAll(async () => { await authority.close(); });

const writerAction = (run_id: RunId): Promise<string> => actionOf(authority, run_id, "writer");
async function launched(request_id = crypto.randomUUID()): Promise<RunId> {
  const { run_id, result } = await launch(authority, { bundle_id, request_id, input: { topic: "Oakridge" } });
  if (!result.ok || result.value.kind !== "committed") throw new Error(`launch failed: ${JSON.stringify(result)}`);
  return run_id;
}
const intents = (run_id: RunId) => authority.db.selectFrom("authority.effect_intent").selectAll().where("run_id", "=", run_id).orderBy("updated_at").execute();

test("a launch commits the run, its units, the event with its writer, the receipt and a decodable instruction", async () => {
  const wakes: RunId[] = [];
  const run_id = await launched();
  await submitter(authority, wakes)({ run_id, event: { kind: "worker_started", action: await writerAction(run_id), kbbl_session_id: "sid-1" }, writer: executor(await writerAction(run_id)) });
  const [run, events, receipts, intent_rows, operator_events] = await Promise.all([
    authority.db.selectFrom("authority.run").selectAll().where("id", "=", run_id).executeTakeFirstOrThrow(),
    authority.db.selectFrom("authority.event").select(["payload", "writer"]).where("run_id", "=", run_id).orderBy("created_at").execute(),
    authority.db.selectFrom("authority.ingress_receipt").select("result").where("run_id", "=", run_id).execute(),
    intents(run_id),
    authority.db.selectFrom("authority.operator_event").select("payload").where("run_id", "=", run_id).execute(),
  ]);
  const root = await authority.db.selectFrom("authority.unit").select("status")
    .where("run_id", "=", run_id).where("id", "=", run_id).executeTakeFirstOrThrow();
  const instruction = decodeEffectInstruction(intent_rows[0]?.payload);
  expect({ root: run.root_unit_id, status: root.status.kind, writers: events.map((event) => event.writer.kind),
    receipts: receipts.map((receipt) => receipt.result.kind), intents: intent_rows.length,
    inputs: instruction.ok ? instruction.value.inputs : null, worker: instruction.ok ? instruction.value.worker.kind : null,
    operator_events: operator_events.length, wakes }).toEqual({ root: run_id, status: "active", writers: ["operator", "executor"],
    receipts: ["committed", "committed"], intents: 1, inputs: { topic: "Oakridge", critique: null }, worker: "agent",
    operator_events: 2, wakes: [run_id] });
});

test("a launch's session settings for a stage reach that stage's agent instruction", async () => {
  const settings = { harness: "codex", model: "gpt-6-sol", effort: "high" };
  const { run_id, result } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" },
    config: { sessions: { document: settings } } });
  if (!result.ok || result.value.kind !== "committed") throw new Error("launch failed");
  const [intent] = await intents(run_id);
  const instruction = decodeEffectInstruction(intent?.payload);
  expect(instruction.ok && instruction.value.worker.kind === "agent" ? instruction.value.worker.settings : null).toEqual(settings);
});

test("an agent instruction pins its prompt digest from the definition", async () => {
  const run_id = await launched();
  const [intent] = await intents(run_id);
  const pinned = await authority.db.selectFrom("authority.definition_bundle").select("prompts").where("id", "=", bundle_id).executeTakeFirstOrThrow();
  const instruction = decodeEffectInstruction(intent?.payload);
  expect(instruction.ok && instruction.value.worker.kind === "agent" ? instruction.value.worker.prompt
    : null).toEqual({ path: "review-loop/write.md", digest: pinned.prompts["review-loop/write.md"]! });
});

test("a revise instruction carries the requested revision and the decision payload", async () => {
  const run_id = await launched();
  const submit = submitter(authority);
  const unit = unitOf(run_id, "document");
  const action = await writerAction(run_id);
  await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "Long" }, by: action }, writer: executor(action) });
  await submit({ run_id, event: { kind: "worker_ended", action, result: { kind: "succeeded" } }, writer: executor(action) });
  await submit({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision: "request_changes",
    target: `${unit}:draft:1`, payload: { feedback: "shorter" } } });
  const revise = (await intents(run_id)).map((row) => decodeEffectInstruction(row.payload))
    .find((decoded) => decoded.ok && decoded.value.action.mode.kind === "revise");
  expect(revise?.ok ? { previous: revise.value.engine_inputs.previous?.id, feedback: revise.value.engine_inputs.feedback } : null)
    .toEqual({ previous: `${unit}:draft:1`, feedback: { feedback: "shorter" } });
});

test("a replayed ingress id returns its stored result, and reused with other content it conflicts", async () => {
  const request_id = crypto.randomUUID();
  const run_id = await launched(request_id);
  const replay = await launch(authority, { bundle_id, request_id, input: { topic: "Oakridge" } });
  const changed = await launch(authority, { bundle_id, request_id, input: { topic: "Other" } });
  const event_count = (await authority.db.selectFrom("authority.event").select("id").where("run_id", "=", run_id).execute()).length;
  expect({ replay: replay.result.ok && replay.result.value.kind, changed: changed.result.ok && changed.result.value.kind, event_count })
    .toEqual({ replay: "replayed", changed: "conflict", event_count: 1 });
});

test("concurrent identical launches create one run and one event", async () => {
  const request_id = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => launch(authority, { bundle_id, request_id, input: { topic: "Oakridge" } })));
  const run_id = results[0]!.run_id;
  const events = await authority.db.selectFrom("authority.event").select("id").where("run_id", "=", run_id).execute();
  expect({ kinds: results.map(({ result }) => result.ok ? result.value.kind : "error").sort(), events: events.length })
    .toEqual({ kinds: ["committed", "replayed", "replayed", "replayed", "replayed"], events: 1 });
});

test("a step rejection is stored as a rejected receipt, replays as rejected, and writes no event", async () => {
  const request_id = crypto.randomUUID();
  const first = await launch(authority, { bundle_id, request_id, input: { topic: 5 } });
  const replay = await launch(authority, { bundle_id, request_id, input: { topic: 5 } });
  const receipt = await authority.db.selectFrom("authority.ingress_receipt").select("result").where("run_id", "=", first.run_id).executeTakeFirstOrThrow();
  const events = await authority.db.selectFrom("authority.event").select("id").where("run_id", "=", first.run_id).execute();
  const listed = (await listRuns(authority.db, { after: null, limit: 100, is_archived: false })).items.map((read) => read.run.id);
  expect({ first: first.result.ok && first.result.value.kind, replay: replay.result.ok && replay.result.value.kind === "replayed" && replay.result.value.receipt.kind,
    receipt: receipt.result.kind, events: events.length, is_listed: listed.includes(first.run_id) })
    .toEqual({ first: "rejected", replay: "rejected", receipt: "rejected", events: 0, is_listed: false });
});

test("a refused launch leaves no run row, and its receipt answers a replay or a changed request", async () => {
  const request_id = crypto.randomUUID();
  const first = await launch(authority, { bundle_id, request_id, input: { topic: 5 } });
  const replay = await launch(authority, { bundle_id, request_id, input: { topic: 5 } });
  const changed = await launch(authority, { bundle_id, request_id, input: { topic: "Oakridge" } });
  const runs = await authority.db.selectFrom("authority.run").select("id").where("id", "=", first.run_id).execute();
  const receipts = await authority.db.selectFrom("authority.ingress_receipt").select("result").where("run_id", "=", first.run_id).execute();
  expect({ first: first.result.ok && first.result.value.kind, replay: replay.result.ok && replay.result.value.kind,
    changed: changed.result.ok && changed.result.value.kind, runs: runs.length, receipts: receipts.map((receipt) => receipt.result.kind) })
    .toEqual({ first: "rejected", replay: "replayed", changed: "conflict", runs: 0, receipts: ["rejected"] });
});

test("concurrent identical refused launches store one receipt and leave no run row", async () => {
  const request_id = crypto.randomUUID();
  const results = await Promise.all(Array.from({ length: 5 }, () => launch(authority, { bundle_id, request_id, input: { topic: 5 } })));
  const run_id = results[0]!.run_id;
  const [runs, receipts] = await Promise.all([
    authority.db.selectFrom("authority.run").select("id").where("id", "=", run_id).execute(),
    authority.db.selectFrom("authority.ingress_receipt").select("id").where("run_id", "=", run_id).execute()]);
  expect({ kinds: results.map(({ result }) => result.ok ? result.value.kind : "error").sort(), runs: runs.length, receipts: receipts.length })
    .toEqual({ kinds: ["rejected", "replayed", "replayed", "replayed", "replayed"], runs: 0, receipts: 1 });
});

test("an event that leaves a unit's wanted set unchanged logs nothing for the unit", async () => {
  const run_id = await launched();
  const action = await writerAction(run_id);
  const unit = unitOf(run_id, "document");
  const submit = submitter(authority);
  await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "first" }, by: action }, writer: executor(action) });
  const logged = await authority.db.selectFrom("authority.wanted_log as wanted").innerJoin("authority.event as event", "event.id", "wanted.event_id")
    .select("wanted.actions").where("wanted.run_id", "=", run_id).where("wanted.unit_id", "=", unit)
    .orderBy("event.created_at").orderBy("event.id").execute();
  const repeats = logged.filter((row, index) => index > 0 && JSON.stringify(row.actions) === JSON.stringify(logged[index - 1]!.actions));
  expect({ logged: logged.length > 0, repeats: repeats.length }).toEqual({ logged: true, repeats: 0 });
});

test("the operator event uses the timestamp returned by the event insert", async () => {
  const run_id = await launched();
  await sql`CREATE FUNCTION authority.override_event_time() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.payload->>'kind' = 'cancel_requested' THEN
        NEW.created_at := TIMESTAMPTZ '2001-02-03 04:05:06.123+00';
      END IF;
      RETURN NEW;
    END
  $$`.execute(authority.db);
  await sql`CREATE TRIGGER override_event_time BEFORE INSERT ON authority.event
    FOR EACH ROW EXECUTE FUNCTION authority.override_event_time()`.execute(authority.db);
  try {
    const committed = await submitter(authority)({ run_id, event: { kind: "cancel_requested" } });
    if (!committed.ok || committed.value.kind !== "committed") throw new Error("cancel did not commit");
    const event_id = committed.value.event_id;
    const [event, operator_events] = await Promise.all([
      authority.db.selectFrom("authority.event").select("created_at").where("id", "=", event_id).executeTakeFirstOrThrow(),
      authority.db.selectFrom("authority.operator_event").select("payload").where("run_id", "=", run_id)
        .where((eb) => eb(eb.ref("payload", "->>").key("kind"), "=", "run_event")).execute(),
    ]);
    const operator = operator_events.find((row) => row.payload.kind === "run_event" && row.payload.data.event_id === event_id);
    expect({ stored: event.created_at.toISOString(), delivered: operator?.payload.kind === "run_event" ? operator.payload.data.occurred_at : null })
      .toEqual({ stored: "2001-02-03T04:05:06.123Z", delivered: "2001-02-03T04:05:06.123Z" });
  } finally {
    await sql`DROP TRIGGER override_event_time ON authority.event`.execute(authority.db);
    await sql`DROP FUNCTION authority.override_event_time()`.execute(authority.db);
  }
});

test("C4: a decision on a non-latest revision is refused at commit", async () => {
  const run_id = await launched();
  const submit = submitter(authority);
  const unit = unitOf(run_id, "document");
  const action = await writerAction(run_id);
  await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid" }, writer: executor(action) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "one" }, by: action }, writer: executor(action) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "two" },
    predecessor: `${unit}:draft:1`, by: action }, writer: executor(action) });
  const stale = await submit({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision: "approve", target: `${unit}:draft:1`, payload: {} } });
  expect(stale.ok && stale.value.kind).toBe("rejected");
});

test("C4: a retry of a worker whose latest attempt did not fail is refused at commit", async () => {
  const run_id = await launched();
  const retry = await submitter(authority)({ run_id, event: { kind: "retry_requested", unit: unitOf(run_id, "document"), worker: "writer" } });
  expect(retry.ok && retry.value.kind).toBe("rejected");
});

test("C4: a revision published by an attempt that is not current is refused at commit", async () => {
  const run_id = await launched();
  const unit = unitOf(run_id, "document");
  const published = await submitter(authority)({ run_id, event: { kind: "revision_published", unit, artifact: "draft",
    body: { title: "T", body: "B" }, by: `${unit}:critic:Review:Missing` }, writer: executor(await writerAction(run_id)) });
  expect(published.ok && published.value.kind).toBe("rejected");
});

test("cancel requests the stop of every live intent of the run", async () => {
  const run_id = await launched();
  await submitter(authority)({ run_id, event: { kind: "cancel_requested" } });
  const [rows, run] = await Promise.all([intents(run_id),
    authority.db.selectFrom("authority.unit").select("status").where("run_id", "=", run_id).where("id", "=", run_id).executeTakeFirstOrThrow()]);
  expect({ statuses: rows.map((row) => row.status), run: run.status.kind }).toEqual({ statuses: ["stop_requested"], run: "cancelled" });
});

test("a core that has not compiled the pinned workflow compiles it from the pinned prompts", async () => {
  const started = CoreClient.start();
  if (!started.ok) throw new Error("core WASM did not load");
  try {
    const fresh = { db: authority.db, core: started.value };
    const { result } = await launch(fresh, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
    expect(result.ok && result.value.kind).toBe("committed");
  } finally { started.value.close(); }
});

test("a code worker compiles against the declared operations and its launch writes a code instruction", async () => {
  const { bundle_id: fan_out } = await pinSample(authority, "fan-out");
  const { run_id } = await launch(authority, { bundle_id: fan_out, request_id: crypto.randomUUID(),
    input: { repository: { repository_path: "/srv/repo", expected_head: null }, items: [] } });
  const instructions = (await intents(run_id)).map((row) => decodeEffectInstruction(row.payload));
  expect(instructions.map((decoded) => decoded.ok && [decoded.value.worker, decoded.value.inputs]))
    .toEqual([[{ kind: "code", operation: "repository.prepare", every: null, artifact: "workspace" }, { repository_path: "/srv/repo", expected_head: null }]]);
});

const PERIODIC: Workflow = {
  workflow: "periodic", input: { repository_path: "repo_path", expected_head: "optional(text)" },
  run: { units: { watch: { stage: "watch", input: { repository_path: "input.repository_path", expected_head: "input.expected_head" } } }, outcome: {} },
  stages: { watch: { input: { repository_path: "repo_path", expected_head: "optional(text)" },
    artifacts: { workspace: { schema: { repository_path: "repo_path", push_remote_owner: "ident", head: "ident" } } },
    workers: { prepare: { kind: "code", operation: "repository.prepare", every: "1s", creates: ["workspace"],
      inputs: { repository_path: "input.repository_path", expected_head: "input.expected_head" } } },
    done_when: "false", outcome: {} } },
};
test("a periodic worker keeps one intent across its attempts, which carries the schedule", async () => {
  const { bundle_id: periodic } = await pinWorkflow(authority, PERIODIC);
  const { run_id, result } = await launch(authority, { bundle_id: periodic, request_id: crypto.randomUUID(), input: { repository_path: "/srv/repo", expected_head: null } });
  if (!result.ok || result.value.kind !== "committed") throw new Error(JSON.stringify(result));
  const [first] = await intents(run_id);
  if (!first) throw new Error("launch wrote no intent");
  const submit = submitter(authority);
  for (const seq of [1, 2]) {
    await submit({ run_id, event: { kind: "worker_started", action: first.action_id, kbbl_session_id: null }, writer: executor(first.action_id), ingress_id: `started:${seq}` });
    await submit({ run_id, event: { kind: "worker_ended", action: first.action_id, result: { kind: "succeeded" } }, writer: executor(first.action_id), ingress_id: `ended:${seq}` });
  }
  const [rows, attempts] = await Promise.all([intents(run_id),
    authority.db.selectFrom("authority.attempt").select("seq").where("run_id", "=", run_id).orderBy("seq").execute()]);
  const instruction = decodeEffectInstruction(rows[0]?.payload);
  expect({ intents: rows.map((row) => row.seq), attempts: attempts.map((attempt) => attempt.seq), every: instruction.ok && instruction.value.worker })
    .toEqual({ intents: [1], attempts: [1, 2], every: { kind: "code", operation: "repository.prepare", every: "1s", artifact: "workspace" } });
});

test("a request digest ignores key order and changes with the event or the writer", () => {
  const writer = { kind: "operator", subject: "credential:a" } as const;
  const digest = requestDigest({ event: { kind: "launched", input: { a: 1, b: 2 } }, writer });
  expect({ reordered: requestDigest({ event: { kind: "launched", input: { b: 2, a: 1 } }, writer }) === digest,
    other_event: requestDigest({ event: { kind: "launched", input: { a: 1, b: 3 } }, writer }) === digest,
    other_writer: requestDigest({ event: { kind: "launched", input: { a: 1, b: 2 } }, writer: { kind: "operator", subject: "credential:b" } }) === digest })
    .toEqual({ reordered: true, other_event: false, other_writer: false });
});

test("a launch's request digest changes with its project or config", () => {
  const request = { event: { kind: "launched", input: { a: 1 } }, writer: OPERATOR } as const;
  const launch = { definition_bundle_id: bundle_id, project_id: null, config: null };
  const digest = requestDigest({ ...request, launch });
  expect({ other_project: requestDigest({ ...request, launch: { ...launch, project_id: "project-b" as ProjectId } }) === digest,
    other_config: requestDigest({ ...request, launch: { ...launch, config: { sessions: {} } } }) === digest })
    .toEqual({ other_project: false, other_config: false });
});

test("an awaiting operator review's prompt is rendered with its resolved inputs, re-rendered as they change, and dropped once decided", async () => {
  const run_id = await launched();
  const unit = unitOf(run_id, "document");
  const submit = submitter(authority);
  const writer = await writerAction(run_id);
  const prompts = async () => (await authority.db.selectFrom("authority.unit").select("review_prompts").where("run_id", "=", run_id)
    .where("id", "=", unit).executeTakeFirstOrThrow()).review_prompts;
  await submit({ run_id, event: { kind: "worker_started", action: writer, kbbl_session_id: "sid-w" }, writer: executor(writer) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "A long draft" }, predecessor: null, subject: null, by: writer },
    writer: { kind: "session", session: "sid-w", attempt: writer } });
  const drafted = await prompts();
  // The critic reviews the draft once the writer's attempt has ended.
  await submit({ run_id, event: { kind: "worker_ended", action: writer, result: { kind: "succeeded" } }, writer: executor(writer) });
  const critic = (await authority.db.selectFrom("authority.attempt").select("action_id").where("run_id", "=", run_id).where("worker", "=", "critic")
    .executeTakeFirstOrThrow()).action_id;
  await submit({ run_id, event: { kind: "worker_started", action: critic, kbbl_session_id: "sid-c" }, writer: executor(critic) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "critique", body: { notes: ["tighten the opening"] }, predecessor: null,
    subject: `${unit}:draft:1`, by: critic }, writer: { kind: "session", session: "sid-c", attempt: critic } });
  const critiqued = await prompts();
  await submit({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision: "approve", target: `${unit}:draft:1`, payload: {} } });
  expect({ target: drafted.editor?.target, topic: drafted.editor?.prompt.includes("topic Oakridge"), draft: drafted.editor?.prompt.includes("A long draft"),
    no_critique_yet: drafted.editor?.prompt.includes("critique none"), critique: critiqued.editor?.prompt.includes("tighten the opening"), decided: await prompts() })
    .toEqual({ target: `${unit}:draft:1`, topic: true, draft: true, no_critique_yet: true, critique: true, decided: {} });
});

test("a templated operator review renders its pinned prompt", async () => {
  const source = sampleWorkflow("review-loop");
  const editor = source.stages.document?.reviews?.editor;
  if (!editor) throw new Error("editor review absent");
  const templated = { ...source, reviews: { editor }, stages: {
    ...source.stages,
    document: { ...source.stages.document!, reviews: { editor: { template: "editor" } } },
  } } as unknown as Workflow;
  const pinned = await pinWorkflow(authority, templated);
  const { run_id, result } = await launch(authority, {
    bundle_id: pinned.bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" },
  });
  if (!result.ok || result.value.kind !== "committed") throw new Error("launch failed");
  const unit = unitOf(run_id, "document");
  const writer = await writerAction(run_id);
  const submit = submitter(authority);
  await submit({ run_id, event: { kind: "worker_started", action: writer, kbbl_session_id: "sid-template" }, writer: executor(writer) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "Body" },
    predecessor: null, subject: null, by: writer },
    writer: { kind: "session", session: "sid-template", attempt: writer } });
  const row = await authority.db.selectFrom("authority.unit").select("review_prompts")
    .where("run_id", "=", run_id).where("id", "=", unit).executeTakeFirstOrThrow();
  expect(row.review_prompts.editor?.prompt.includes("topic Oakridge")).toBe(true);
});

// ---------------------------------------------------- commit correctness -----

const attemptsOf = (run_id: RunId, worker: string) => authority.db.selectFrom("authority.attempt").select(["action_id", "seq", "status", "cause"])
  .where("run_id", "=", run_id).where("worker", "=", worker).orderBy("created_at").execute();
const failed = { kind: "failed", code: "oops", detail: "failed" } as const;
async function failLatest(run_id: RunId, worker: string): Promise<void> {
  const submit = submitter(authority);
  const action = (await attemptsOf(run_id, worker)).at(-1)!.action_id;
  await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: null }, writer: executor(action) });
  await submit({ run_id, event: { kind: "worker_ended", action, result: failed }, writer: executor(action) });
}

test("a unit that starts after its dependency persists the input it resolved, and its validation reads it", async () => {
  const stage = (input: Record<string, string>, inputs: Record<string, string>, validate: { check: string; message: string }[]) => ({
    input, artifacts: { draft: { schema: "text", validate } },
    workers: { writer: { kind: "agent", prompts: { initial: "review-loop/write.md", revise: "review-loop/revise.md" }, inputs, creates: ["draft"] } },
    done_when: "published(draft)", outcome: { draft: "latest(draft)" } });
  const workflow = { workflow: "chain", input: { topic: "text" },
    run: { units: { first: { stage: "first", input: { topic: "input.topic" } },
      second: { stage: "second", input: { topic: "input.topic", draft: "first.outcome.draft" } } },
    outcome: { draft: "second.outcome.draft" } },
    stages: { first: stage({ topic: "text" }, { topic: "input.topic" }, []),
      second: stage({ topic: "text", draft: "text" }, { topic: "input.topic", draft: "input.draft" },
        [{ check: "draft == input.draft", message: "the draft must repeat the first stage's draft" }]) } } as unknown as Workflow;
  const { bundle_id: chain } = await pinWorkflow(authority, workflow);
  const { run_id, result } = await launch(authority, { bundle_id: chain, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  if (!result.ok || result.value.kind !== "committed") throw new Error("launch failed");
  const submit = submitter(authority);
  const publish = async (key: string) => {
    const action = (await attemptsOf(run_id, "writer")).at(-1)!.action_id;
    await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: null }, writer: executor(action) });
    await submit({ run_id, event: { kind: "revision_published", unit: unitOf(run_id, key), artifact: "draft", body: "hello", predecessor: null, subject: null,
      by: action }, writer: executor(action) });
  };
  await publish("first");
  const second = await authority.db.selectFrom("authority.unit").select(["input", "status"]).where("run_id", "=", run_id)
    .where("id", "=", unitOf(run_id, "second")).executeTakeFirstOrThrow();
  await publish("second");
  const decisions = await authority.db.selectFrom("authority.review_decision").select("review").where("run_id", "=", run_id).execute();
  expect({ status: second.status.kind, input: second.input, decisions: decisions.map((decision) => decision.review) })
    .toEqual({ status: "active", input: { topic: "Oakridge", draft: "hello" }, decisions: [] });
});

test("a retry attempt that fails waits for another retry request", async () => {
  const run_id = await launched();
  await failLatest(run_id, "writer");
  await submitter(authority)({ run_id, event: { kind: "retry_requested", unit: unitOf(run_id, "document"), worker: "writer" } });
  await failLatest(run_id, "writer");
  const attempts = await attemptsOf(run_id, "writer");
  expect({ attempts: attempts.map((attempt) => attempt.status.kind), intents: (await intents(run_id)).length })
    .toEqual({ attempts: ["failed", "failed"], intents: 2 });
});

test("a second retry request while the retry attempt runs is rejected, and its later failure starts nothing", async () => {
  const run_id = await launched();
  const unit = unitOf(run_id, "document");
  const submit = submitter(authority);
  await failLatest(run_id, "writer");
  await submit({ run_id, event: { kind: "retry_requested", unit, worker: "writer" } });
  const retried = (await attemptsOf(run_id, "writer")).at(-1)!.action_id;
  await submit({ run_id, event: { kind: "worker_started", action: retried, kbbl_session_id: null }, writer: executor(retried) });
  const second = await submit({ run_id, event: { kind: "retry_requested", unit, worker: "writer" } });
  await submit({ run_id, event: { kind: "worker_ended", action: retried, result: failed }, writer: executor(retried) });
  const attempts = await attemptsOf(run_id, "writer");
  expect({ second: second.ok && second.value.kind, attempts: attempts.map((attempt) => attempt.status.kind) })
    .toEqual({ second: "rejected", attempts: ["failed", "failed"] });
});

test("a retry that already ran is not reused when a later attempt fails", async () => {
  const run_id = await launched();
  const unit = unitOf(run_id, "document");
  const submit = submitter(authority);
  await failLatest(run_id, "writer");
  await submit({ run_id, event: { kind: "retry_requested", unit, worker: "writer" } });
  const retried = (await attemptsOf(run_id, "writer")).at(-1)!.action_id;
  await submit({ run_id, event: { kind: "worker_started", action: retried, kbbl_session_id: null }, writer: executor(retried) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "Long" }, predecessor: null, subject: null,
    by: retried }, writer: executor(retried) });
  await submit({ run_id, event: { kind: "worker_ended", action: retried, result: { kind: "succeeded" } }, writer: executor(retried) });
  await submit({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision: "request_changes", target: `${unit}:draft:1`,
    payload: { feedback: "shorter" } } });
  await failLatest(run_id, "writer");
  const attempts = await attemptsOf(run_id, "writer");
  expect(attempts.map((attempt) => [attempt.cause.kind, attempt.status.kind]))
    .toEqual([["missing", "failed"], ["retry", "succeeded"], ["changes_requested", "failed"]]);
});

test("an event naming a unit the run does not have is a stored rejection, not a fault", async () => {
  const run_id = await launched();
  const ingress_id = crypto.randomUUID();
  const decided = await submitter(authority)({ run_id, ingress_id, event: { kind: "operator_decided", unit: unitOf(run_id, "nope"), review: "editor",
    decision: "approve", target: "nope:draft:1", payload: {} } });
  const receipt = await authority.db.selectFrom("authority.ingress_receipt").select(["unit_id", "result"]).where("run_id", "=", run_id)
    .where("ingress_id", "=", `operator:${ingress_id}`).executeTakeFirstOrThrow();
  expect({ outcome: decided.ok && decided.value.kind, unit: receipt.unit_id, result: receipt.result.kind })
    .toEqual({ outcome: "rejected", unit: null, result: "rejected" });
});

test("an operator cannot claim the ingress id the executor reports an attempt under", async () => {
  const run_id = await launched();
  const action = await writerAction(run_id);
  const submit = submitter(authority);
  const reported = `worker_ended:${action}:1`;
  await submit({ run_id, event: { kind: "worker_started", action, kbbl_session_id: null }, writer: executor(action) });
  const squatted = await submit({ run_id, ingress_id: reported, event: { kind: "retry_requested", unit: unitOf(run_id, "document"), worker: "writer" } });
  const ended = await submit({ run_id, ingress_id: reported, event: { kind: "worker_ended", action, result: failed }, writer: executor(action) });
  expect({ squatted: squatted.ok && squatted.value.kind, ended: ended.ok && ended.value.kind }).toEqual({ squatted: "rejected", ended: "committed" });
});
