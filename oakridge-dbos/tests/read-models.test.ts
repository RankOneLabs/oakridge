import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { installDefinitionApi } from "../src/http/app";
import type { ArtifactDetail, DefinitionDetail, DefinitionPage, InboxPage, PinnedDefinition, RunInspectView, RunPage, RunView,
  UnitDiagnostics, UnitHistory, UnitView } from "../src/http/operator-api";
import type { RunEvent } from "../src/projections/run-event";
import type { SessionHoldResponse } from "../src/projections/session-hold";
import { actionOf, executor, launch, openAuthority, pinSample, submitter, unitOf, type Authority } from "./authority-fixture";

/**
 * Each read model carries exactly its contract's fields, and every derived
 * field is tested. Runs go through commit; reads go through the HTTP surface.
 */
const CONTRACT_FIELDS = {
  RunView: ["archived_at", "created_at", "definition_bundle_id", "definition_digest", "run_id", "status", "units"],
  RunUnitSummary: ["asks", "is_terminal", "label", "stage", "status", "unit_id", "unit_key"],
  UnitView: ["artifacts", "attempts", "attention", "collection_key", "decisions", "depends_on", "input", "is_terminal", "label", "outcome",
    "run_id", "stage", "status", "unit_id", "unit_key"],
  AttemptView: ["cause", "created_at", "failure", "id", "is_current", "kbbl_session_id", "mode", "number", "status", "unit_id", "worker"],
  ArtifactView: ["artifact_key", "is_editable", "is_reviewable", "latest_revision", "revision_count", "run_id", "schema", "unit_id"],
  ArtifactRevisionView: ["artifact_key", "attempt_id", "body", "created_at", "id", "number", "predecessor_id", "run_id", "subject_id", "unit_id"],
  DecisionDefinition: ["fields", "key", "label", "payload_schema", "submit"],
  DecisionField: ["key", "label"],
  InboxPage: ["items", "next_cursor"],
  InboxDecisionItem: ["key", "kind", "label", "prompt", "run_id", "submit", "unit_id"],
  InboxWaitingItem: ["kind", "label", "reason", "run_id", "unit_id"],
  InboxStalledItem: ["detail", "kind", "run_id", "unit_id"],
  UnitHistory: ["events", "next_cursor", "unit_id"],
  EventHistory: ["created_at", "event", "id", "ingress_id", "writer"],
  UnitDiagnostics: ["attempts", "effects", "rejected", "unit_id"],
  EffectDiagnostic: ["action_id", "id", "last_error", "next_try_at", "seq", "status", "tries", "updated_at"],
  ArtifactDetail: ["artifact_key", "decisions", "is_editable", "is_reviewable", "revisions", "run_id", "schema", "status", "unit_id"],
  DefinitionSummary: ["archived_at", "bundle", "bundle_id", "digest"],
  PinnedDefinition: ["archived_at", "bundle", "bundle_id", "checked_program", "digest"],
  DefinitionDetail: ["archived_at", "bundle", "bundle_id", "digest", "graph", "workflow"],
  DefinitionBundle: ["key", "root", "schemas", "units", "version"],
  UnitDefinition: ["artifacts", "input_schema", "key", "label", "stage"],
  ArtifactDefinition: ["key", "schema"],
  Schema: ["key", "shape"],
  RunEvent: ["awaiting", "event_id", "is_terminal", "kind", "occurred_at", "run_id", "run_status", "unit_id", "unit_key"],
  AwaitingReviewNotice: ["label", "review"],
} as const;
type ReadModelName = keyof typeof CONTRACT_FIELDS;
let authority: Authority;
let app: Hono;
let review_loop: DefinitionBundleId;
let fan_out: DefinitionBundleId;
beforeAll(async () => {
  authority = await openAuthority();
  app = new Hono();
  installDefinitionApi(app, { db: authority.db, core: authority.core, wake: () => undefined, is_operator_request: () => false });
  review_loop = (await pinSample(authority)).bundle_id;
  fan_out = (await pinSample(authority, "fan-out")).bundle_id;
});
afterAll(async () => { await authority.close(); });

const segment = encodeURIComponent;
async function get<Body>(path: string): Promise<Body> {
  const response = await app.request(path);
  if (response.status !== 200) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return await response.json() as Body;
}
const unitPath = (run_id: string, unit: string, rest = ""): string => `/api/runs/${segment(run_id)}/units/${segment(unit)}${rest}`;
const fields = (value: object): readonly string[] => Object.keys(value).sort();
const holds = (model: ReadModelName, value: object | null | undefined): void => {
  if (!value) throw new Error(`${model}: no value to check`);
  expect({ model, fields: fields(value) }).toEqual({ model, fields: [...CONTRACT_FIELDS[model]] });
};

async function launched(bundle_id: DefinitionBundleId, input: unknown): Promise<RunId> {
  const { run_id, result } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input });
  if (!result.ok || result.value.kind !== "committed") throw new Error("launch failed");
  return run_id;
}
/** Sample A with the writer's first draft published: the editor's review awaits and the critic is pending. */
async function drafted(): Promise<{ readonly run_id: RunId; readonly unit: string; readonly writer: string }> {
  const run_id = await launched(review_loop, { topic: "Oakridge" });
  const unit = unitOf(run_id, "document");
  const writer = await actionOf(authority, run_id, "writer");
  const submit = submitter(authority);
  await submit({ run_id, event: { kind: "worker_started", action: writer, kbbl_session_id: "sid-writer" }, writer: executor(writer) });
  await submit({ run_id, event: { kind: "revision_published", unit, artifact: "draft", body: { title: "T", body: "first" }, by: writer }, writer: executor(writer) });
  return { run_id, unit, writer };
}
/** Sample A with the writer's first attempt failed: the worker is stalled. */
async function stalled(): Promise<{ readonly run_id: RunId; readonly unit: string }> {
  const run_id = await launched(review_loop, { topic: "Oakridge" });
  const writer = await actionOf(authority, run_id, "writer");
  await submitter(authority)({ run_id, event: { kind: "worker_ended", action: writer, result: { kind: "failed", code: "boom", detail: "it broke" } }, writer: executor(writer) });
  return { run_id, unit: unitOf(run_id, "document") };
}
const decide = (run_id: RunId, unit: string, decision: string, target: string, payload: object) =>
  submitter(authority)({ run_id, event: { kind: "operator_decided", unit, review: "editor", decision, target, payload } });
/** Sample B with `prepare` published: the work group is active and its items exist. */
async function fanned(): Promise<RunId> {
  const run_id = await launched(fan_out, { repository: { repository_path: "/tmp/repo", expected_head: null },
    items: [{ key: "a", text: "A", after: [] }, { key: "c", text: "C", after: ["a"] }] });
  const git = await actionOf(authority, run_id, "git");
  const prepare = unitOf(run_id, "prepare");
  const submit = submitter(authority);
  await submit({ run_id, event: { kind: "worker_started", action: git }, writer: executor(git) });
  await submit({ run_id, event: { kind: "revision_published", unit: prepare, artifact: "workspace",
    body: { repository_path: "/tmp/repo", push_remote_owner: "owner", head: "abc" }, by: git }, writer: executor(git) });
  return run_id;
}
async function runEvents(run_id: string): Promise<readonly RunEvent[]> {
  const rows = await authority.db.selectFrom("authority.operator_event").select(["payload"]).where("run_id", "=", run_id)
    .where("event_key", "=", "run_event").orderBy("commit_txid").orderBy("created_at").execute();
  return rows.flatMap((row) => row.payload.kind === "run_event" ? [row.payload.data] : []);
}

describe("each read model carries exactly its contract's fields", () => {
  test("runs and run units", async () => {
    const { run_id } = await drafted();
    const page = await get<RunPage>("/api/runs");
    const view = await get<RunView>(`/api/runs/${segment(run_id)}`);
    holds("RunView", view);
    holds("RunView", page.items[0]);
    holds("RunUnitSummary", view.units[0]);
    expect(fields(page)).toEqual(["items", "next_cursor"]);
  });

  test("a unit, its attempts, artifacts, revisions and decisions", async () => {
    const { run_id, unit } = await drafted();
    const view = await get<UnitView>(unitPath(run_id, unit));
    holds("UnitView", view);
    holds("AttemptView", view.attempts[0]);
    holds("ArtifactView", view.artifacts[0]);
    holds("ArtifactRevisionView", view.artifacts.find((artifact) => artifact.latest_revision)?.latest_revision);
    holds("DecisionDefinition", view.decisions[0]);
  });

  test("the inbox and each kind of item", async () => {
    await drafted();
    await stalled();
    const inbox = await get<InboxPage>("/api/inbox");
    holds("InboxPage", inbox);
    holds("InboxDecisionItem", inbox.items.find((item) => item.kind === "decision"));
    holds("InboxWaitingItem", inbox.items.find((item) => item.kind === "waiting"));
    holds("InboxStalledItem", inbox.items.find((item) => item.kind === "stalled"));
  });

  test("history, diagnostics and their entries", async () => {
    const { run_id, unit } = await drafted();
    const history = await get<UnitHistory>(unitPath(run_id, unit, "/history"));
    const diagnostics = await get<UnitDiagnostics>(unitPath(run_id, unit, "/diagnostics"));
    holds("UnitHistory", history);
    holds("EventHistory", history.events[0]);
    holds("UnitDiagnostics", diagnostics);
    holds("EffectDiagnostic", diagnostics.effects[0]);
  });

  test("artifact detail", async () => {
    const { run_id, unit } = await drafted();
    holds("ArtifactDetail", await get<ArtifactDetail>(unitPath(run_id, unit, "/artifacts/draft")));
  });

  test("definitions, the translated bundle, its units, artifacts and schemas", async () => {
    const run_id = await launched(review_loop, { topic: "Oakridge" });
    const page = await get<DefinitionPage>("/api/definitions");
    const pinned = await get<PinnedDefinition>(`/api/runs/${segment(run_id)}/definition`);
    const detail = await get<DefinitionDetail>(`/api/definitions/${review_loop}`);
    const staged = pinned.bundle.units.find((unit) => unit.artifacts.length > 0);
    holds("DefinitionSummary", page.items[0]);
    holds("PinnedDefinition", pinned);
    holds("DefinitionDetail", detail);
    holds("DefinitionBundle", pinned.bundle);
    holds("UnitDefinition", staged);
    holds("ArtifactDefinition", staged?.artifacts[0]);
    holds("Schema", pinned.bundle.schemas[0]);
  });

  test("the event stream's run event and its awaiting review", async () => {
    const { run_id } = await drafted();
    const events = await runEvents(run_id);
    holds("RunEvent", events[0]);
    holds("AwaitingReviewNotice", events.find((event) => event.awaiting)?.awaiting);
  });
});

describe("derived fields", () => {
  test("run units are labelled by key, the root by its workflow, a collection member by its stage", async () => {
    const run_id = await fanned();
    const view = await get<RunView>(`/api/runs/${segment(run_id)}`);
    expect(view.units.map((unit) => [unit.unit_key, unit.label])).toEqual([
      ["$root", "Fan Out"], ["prepare", "Prepare"], ["work", "Work"], ["item", "Item"], ["item", "Item"]]);
  });

  test("a run unit lists the decisions that ask for the operator, never the run's cancel", async () => {
    const { run_id } = await drafted();
    const view = await get<RunView>(`/api/runs/${segment(run_id)}`);
    const root = await get<UnitView>(unitPath(run_id, run_id));
    expect({ listed: view.units.map((unit) => [unit.unit_key, unit.asks]), root: root.decisions.map((decision) => decision.submit) })
      .toEqual({ listed: [["$root", []], ["document", ["approve", "request_changes"]]], root: [{ kind: "cancel" }] });
  });

  test("an awaiting review offers its decisions, each submitted to that review on the revision it awaits", async () => {
    const { run_id, unit } = await drafted();
    const view = await get<UnitView>(unitPath(run_id, unit));
    const target = `${unit}:draft:1`;
    expect(view.decisions.map((decision) => [decision.key, decision.payload_schema, decision.submit])).toEqual([
      ["approve", "{}", { kind: "review", review: "editor", decision: "approve", effect: "approve", target_revision_id: target }],
      ["request_changes", "{feedback: text}", { kind: "review", review: "editor", decision: "request_changes", effect: "request_changes", target_revision_id: target }],
    ]);
  });

  test("a decided review offers nothing more until the next revision", async () => {
    const { run_id, unit } = await drafted();
    await decide(run_id, unit, "request_changes", `${unit}:draft:1`, { feedback: "more" });
    const view = await get<UnitView>(unitPath(run_id, unit));
    expect({ decisions: view.decisions, attention: view.attention }).toEqual({ decisions: [], attention: null });
  });

  test("a stalled worker offers a retry and its unit's attention is the failure", async () => {
    const { run_id, unit } = await stalled();
    const view = await get<UnitView>(unitPath(run_id, unit));
    expect({ decisions: view.decisions.map((decision) => [decision.key, decision.label, decision.submit]), attention: view.attention })
      .toEqual({ decisions: [["retry:writer", "Retry Writer", { kind: "retry", worker: "writer" }]],
        attention: { kind: "stalled", detail: "writer failed: it broke" } });
  });

  test("a unit's attention: awaiting a review, blocked on another unit, or nothing", async () => {
    const { run_id, unit } = await drafted();
    const fan = await launched(fan_out, { repository: { repository_path: "/tmp/repo", expected_head: null }, items: [] });
    const quiet = await launched(review_loop, { topic: "Oakridge" });
    expect({ awaiting: (await get<UnitView>(unitPath(run_id, unit))).attention,
      blocked: (await get<UnitView>(unitPath(fan, unitOf(fan, "work")))).attention,
      quiet: (await get<UnitView>(unitPath(quiet, unitOf(quiet, "document")))).attention })
      .toEqual({ awaiting: { kind: "waiting", reason: "awaiting editor review" }, blocked: { kind: "waiting", reason: "waiting on Prepare" }, quiet: null });
  });

  test("a finished unit is terminal, done, with its outcome", async () => {
    const { run_id, unit } = await drafted();
    await decide(run_id, unit, "approve", `${unit}:draft:1`, {});
    const view = await get<UnitView>(unitPath(run_id, unit));
    expect({ is_terminal: view.is_terminal, status: view.status.kind, outcome: view.outcome })
      .toEqual({ is_terminal: true, status: "done", outcome: { draft: { title: "T", body: "first" } } });
  });

  test("attempts are numbered per worker, oldest first, and only the latest is current", async () => {
    const { run_id, unit } = await stalled();
    await submitter(authority)({ run_id, event: { kind: "retry_requested", unit, worker: "writer" } });
    const view = await get<UnitView>(unitPath(run_id, unit));
    expect(view.attempts.map((attempt) => [attempt.worker, attempt.number, attempt.status, attempt.is_current, attempt.failure, attempt.cause.kind]))
      .toEqual([["writer", 1, "failed", false, { code: "boom", detail: "it broke" }, "missing"], ["writer", 2, "pending", true, null, "retry"]]);
  });

  test("artifacts carry their schema name, reviewability, editability, revision count and latest revision", async () => {
    const { run_id, unit, writer } = await drafted();
    const view = await get<UnitView>(unitPath(run_id, unit));
    expect(view.artifacts.map((artifact) => [artifact.artifact_key, artifact.schema, artifact.is_reviewable, artifact.is_editable, artifact.revision_count,
      artifact.latest_revision?.number ?? null, artifact.latest_revision?.attempt_id ?? null]))
      .toEqual([["critique", "{notes: list(text)}", false, true, 0, null, null], ["draft", "{body: text, title: text}", true, true, 1, 1, writer]]);
  });

  test("the inbox derives decisions with the review's prompt, each stalled worker, and waits", async () => {
    const drafted_run = await drafted();
    const stalled_run = await stalled();
    const inbox = await get<InboxPage>("/api/inbox");
    const of = (run_id: string) => inbox.items.filter((item) => item.run_id === run_id)
      .map((item) => item.kind === "decision" ? [item.kind, item.key, item.prompt?.startsWith("Review ") ?? null]
        : item.kind === "waiting" ? [item.kind, item.reason, item.label] : [item.kind, item.detail]);
    expect({ drafted: of(drafted_run.run_id), stalled: of(stalled_run.run_id) })
      .toEqual({ drafted: [["decision", "approve", true], ["decision", "request_changes", true], ["waiting", "awaiting editor review", "Document"]],
        stalled: [["decision", "retry:writer", null], ["stalled", "writer failed: it broke"]] });
  });

  test("the inbox leaves out finished and archived runs and pages by run", async () => {
    const done = await drafted();
    await decide(done.run_id, done.unit, "approve", `${done.unit}:draft:1`, {});
    const archived = await drafted();
    await app.request(`/api/runs/${segment(archived.run_id)}/archive`, { method: "POST" });
    const run_ids = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 100; page++) {
      const inbox: InboxPage = await get<InboxPage>(`/api/inbox?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      for (const item of inbox.items) run_ids.add(item.run_id);
      if (inbox.next_cursor === null) break;
      cursor = inbox.next_cursor;
    }
    expect({ done: run_ids.has(done.run_id), archived: run_ids.has(archived.run_id), some: run_ids.size > 0 }).toEqual({ done: false, archived: false, some: true });
  });

  test("history is the unit's events newest first, each with its ingress id and writer", async () => {
    const { run_id, unit } = await drafted();
    const history = await get<UnitHistory>(unitPath(run_id, unit, "/history"));
    expect({ events: history.events.map((event) => [event.event.kind, event.writer.kind, typeof event.ingress_id]), next: history.next_cursor })
      .toEqual({ events: [["revision_published", "executor", "string"], ["worker_started", "executor", "string"]], next: null });
  });

  test("diagnostics carry the unit's intents and the events step refused", async () => {
    const { run_id, unit } = await drafted();
    await decide(run_id, unit, "approve", `${unit}:draft:9`, {});
    const diagnostics = await get<UnitDiagnostics>(unitPath(run_id, unit, "/diagnostics"));
    expect({ effects: diagnostics.effects.map((effect) => effect.status), rejected: diagnostics.rejected.map((receipt) => receipt.reason.length > 0) })
      .toEqual({ effects: ["pending", "pending"], rejected: [true] });
  });

  test("an artifact's status follows the latest decision on its latest revision", async () => {
    const draft = await drafted();
    const rejected = await drafted();
    await decide(rejected.run_id, rejected.unit, "request_changes", `${rejected.unit}:draft:1`, { feedback: "more" });
    const approved = await drafted();
    await decide(approved.run_id, approved.unit, "approve", `${approved.unit}:draft:1`, {});
    const detail = (run: { readonly run_id: string; readonly unit: string }) => get<ArtifactDetail>(unitPath(run.run_id, run.unit, "/artifacts/draft"));
    const [as_draft, as_rejected, as_approved] = await Promise.all([detail(draft), detail(rejected), detail(approved)]);
    expect({ statuses: [as_draft.status, as_rejected.status, as_approved.status], schema: as_draft.schema, is_reviewable: as_draft.is_reviewable,
      revisions: as_draft.revisions.length, decisions: as_rejected.decisions.map((decision) => decision.decision) })
      .toEqual({ statuses: ["draft", "rejected", "approved"], schema: "{body: text, title: text}", is_reviewable: true, revisions: 1, decisions: ["request_changes"] });
  });

  test("a launch's event addresses the root; an event that leaves a review awaiting names it", async () => {
    const { run_id, unit } = await drafted();
    await decide(run_id, unit, "approve", `${unit}:draft:1`, {});
    const events = await runEvents(run_id);
    expect(events.map((event) => [event.kind, event.unit_key, event.awaiting?.review ?? null, event.is_terminal])).toEqual([
      ["launched", "$root", null, false],
      ["worker_started", "document", null, false],
      ["revision_published", "document", "editor", false],
      ["operator_decided", "document", null, true],
    ]);
  });

  test("I3: inspect shows a stalled worker with the retry that clears it", async () => {
    const { run_id } = await stalled();
    const inspect = await get<RunInspectView>(`/api/runs/${segment(run_id)}/inspect`);
    expect({ attention: inspect.attention.map((item) => item.kind === "stalled_worker"
      ? [item.kind, item.worker, item.detail, item.decisions.map((decision) => decision.submit)] : [item.kind]),
      events: inspect.events.map((event) => [event.kind, event.writer.kind]) })
      .toEqual({ attention: [["stalled_worker", "writer", "it broke", [{ kind: "retry", worker: "writer" }]]],
        events: [["worker_ended", "executor"], ["launched", "operator"]] });
  });

  test("a kbbl session is held by the running attempt using it, and by nothing once that attempt ends", async () => {
    const run_id = await launched(review_loop, { topic: "Oakridge" });
    const unit = unitOf(run_id, "document");
    const writer = await actionOf(authority, run_id, "writer");
    const session = `sid-${crypto.randomUUID()}`;
    const submit = submitter(authority);
    await submit({ run_id, event: { kind: "worker_started", action: writer, kbbl_session_id: session }, writer: executor(writer) });
    const held = await get<SessionHoldResponse>(`/session_holds/${session}`);
    await submit({ run_id, event: { kind: "worker_ended", action: writer, result: { kind: "failed", code: "boom", detail: "it broke" } }, writer: executor(writer) });
    const reads: unknown = { held, free: await get<SessionHoldResponse>(`/session_holds/${session}`), unknown: await get<SessionHoldResponse>("/session_holds/sid-unknown") };
    expect(reads).toEqual({ held: { hold: { session_id: session, run_id, unit_id: unit, worker: "writer", action_id: writer } }, free: { hold: null }, unknown: { hold: null } });
  });

  test("a missing unit, artifact or run reads as 404", async () => {
    const { run_id, unit } = await drafted();
    const statuses = await Promise.all([unitPath(run_id, `${run_id}/missing`), unitPath(run_id, unit, "/artifacts/missing"),
      unitPath(run_id, `${run_id}/missing`, "/history"), unitPath(run_id, `${run_id}/missing`, "/diagnostics"), "/api/runs/run-missing/inspect"]
      .map(async (path) => (await app.request(path)).status));
    expect(statuses).toEqual([404, 404, 404, 404, 404]);
  });
});
