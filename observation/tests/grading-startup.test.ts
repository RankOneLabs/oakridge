import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import type { JsonValue } from "../src/domain/primitives";
import { parseGraderConfiguration, planRegistration, type GraderConfiguration } from "../src/grading/configuration";
import type { EvidenceSet } from "../src/grading/evidence";
import type { SourceEventCursor, SourceEventOutcome } from "../src/ingest/cursor";
import type { RepositoryFile, RepositoryReader } from "../src/ports/artifact-source";
import { TASK_SCOPE } from "../src/producers/oakridge/catalogue";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID, RELEVANCE_ID } from "../src/producers/oakridge/questions";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { startObservation } from "../src/main";
import type { RunnerResolver } from "../src/grading/worker";
import type { GradeRunner } from "../src/ports/grade-runner";
import { withTenant, type Database } from "../src/storage/database";
import { declareRelationInTransaction } from "../src/storage/projection-store";
import { committedGraders, credentialEnv, databaseUrl, fixtureBody, integration, launchOutcome, revisionOutcome, runConfig, scratchDatabase,
  tenant } from "./grading-fixture";

const HEAD = "1111111111111111111111111111111111111111";
const credentials = { ingest: [{ ...tenant, token: "ingest-secret" }], read: [{ ...tenant, token: "read-secret" }],
  grade: [{ ...tenant, token: "grade-secret", reviewer_id: "operator" }] };
const launch = { spec: "The whole captured spec", repositories: [
  { key: "docs", preparation: { repository_path: "/repos/docs" } },
  { key: "oakridge", preparation: { repository_path: "/repos/oakridge" } }] };

/** The repository boundary, with access the test can withhold and then grant. */
function repository(): RepositoryReader & { accessible: boolean; reads: string[] } {
  const reader = { accessible: false, reads: [] as string[],
    hasCommit: async (path: string, commit: string) => reader.accessible && path === "/repos/oakridge" && commit === HEAD,
    readFile: async ({ repository_path, commit_sha, path }: { repository_path: string; commit_sha: string; path: string }): Promise<RepositoryFile> => {
      reader.reads.push(`${repository_path}@${commit_sha}:${path}`);
      return reader.accessible ? { state: "present", content: "one\ntwo\nthree" } : { state: "unavailable", detail: "not readable" };
    } };
  return reader;
}

interface Service { readonly port: number; stop(): Promise<void> }
interface Harness {
  start(graders: GraderConfiguration | unknown, runners?: RunnerResolver): Promise<Service>;
  send(service: Service, outcome: SourceEventOutcome): Promise<void>;
  get(service: Service, path: string): Promise<unknown>;
}
async function harness(db: Database, reader: RepositoryReader, directory: string): Promise<Harness> {
  let cursor: SourceEventCursor = { commit_txid: "0", id: "" };
  let sequence = 0;
  const url = await databaseUrl(db);
  return {
    async start(graders, runners) {
      const graders_file = join(directory, `graders-${++sequence}.json`);
      await Bun.write(graders_file, JSON.stringify(graders));
      return startObservation({ ...credentialEnv(graders), OBSERVATION_DATABASE_URL: url, OBSERVATION_PORT: "0",
        OBSERVATION_INGEST_CREDENTIALS: JSON.stringify(credentials.ingest), OBSERVATION_READ_CREDENTIALS: JSON.stringify(credentials.read),
        OBSERVATION_GRADE_CREDENTIALS: JSON.stringify(credentials.grade) }, { graders_file, repository: reader, runners, worker_idle_ms: 20 });
    },
    async send(service, outcome) {
      const next = { commit_txid: String(Number(cursor.commit_txid) + 1), id: outcome.event_id };
      const response = await fetch(`http://127.0.0.1:${service.port}/v1/sources/oakridge/events`, { method: "POST",
        headers: { authorization: "Bearer ingest-secret", "content-type": "application/json" },
        body: JSON.stringify({ previous: cursor, cursor: next, outcome }) });
      expect(response.status).toBe(200);
      cursor = next;
    },
    async get(service, path) {
      const response = await fetch(`http://127.0.0.1:${service.port}${path}`, { headers: { authorization: "Bearer read-secret" } });
      expect(response.status).toBe(200);
      return response.json();
    },
  };
}

interface Item { readonly occurrence_id: string; readonly revision_id: string; readonly json_pointer: string; readonly item_kind: string }
const items = async (h: Harness, service: Service): Promise<readonly Item[]> =>
  ((await h.get(service, "/v1/runs/run-1/items?limit=200")) as { items: Item[] }).items;
const itemAt = async (h: Harness, service: Service, revision_id: string, path: string, kind: string): Promise<Item> => {
  const found = (await items(h, service)).find((item) => item.revision_id === revision_id && item.json_pointer === path && item.item_kind === kind);
  if (!found) throw new Error(`no ${kind} at ${revision_id}${path}`);
  return found;
};
type EvidenceRead = Omit<EvidenceSet, "readiness" | "pinned_evaluator_definition_ids"> & { readonly pinned_evaluator_definition_ids: readonly string[];
  readonly readiness: { state: string; reason?: { code: string }; references?: JsonValue[]; ready_at?: string } };
type ServedEvidence = Omit<EvidenceRead, "readiness" | "pinned_evaluator_definition_ids"> & { readonly pinned_evaluator_definition_ids: { items: string[] };
  readonly readiness: EvidenceRead["readiness"]; readonly references: { items: JsonValue[] } };
/** The served shape with its nested pages read out, the windows wide enough to hold them all. */
const evidenceOf = async (h: Harness, service: Service, item: Item): Promise<readonly EvidenceRead[]> =>
  ((await h.get(service, `/v1/items/${encodeURIComponent(item.occurrence_id)}/evidence?limit=200&references_limit=200&pinned_evaluators_limit=200`)) as { items: ServedEvidence[] }).items
    .map((set) => ({ ...set, pinned_evaluator_definition_ids: set.pinned_evaluator_definition_ids.items,
      readiness: set.readiness.state === "ready" ? { ...set.readiness, references: set.references.items } : set.readiness }));
const question = (sets: readonly EvidenceRead[], id: string): EvidenceRead => {
  const found = sets.find((set) => set.question_id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
};
/** Collection follows the acknowledgement, so readers wait for it to leave `collection_pending`. */
async function settled(h: Harness, service: Service, item: Item, done: (sets: readonly EvidenceRead[]) => boolean): Promise<readonly EvidenceRead[]> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const sets = await evidenceOf(h, service, item);
    if (done(sets)) return sets;
    await Bun.sleep(20);
  }
  throw new Error(`evidence for ${item.json_pointer} did not settle: ${JSON.stringify(await evidenceOf(h, service, item))}`);
}
const collected = (sets: readonly EvidenceRead[]) => sets.length > 0 && sets.every((set) => set.readiness.reason?.code !== "collection_pending");

async function counts(db: Database): Promise<Record<string, number>> {
  return withTenant(db, tenant, async (trx) => (await sql<Record<string, number>>`SELECT
    (SELECT count(*)::integer FROM observation.question_definition) AS questions,
    (SELECT count(*)::integer FROM observation.evaluator_definition) AS evaluators,
    (SELECT count(*)::integer FROM observation.evaluation_execution) AS executions,
    (SELECT count(*)::integer FROM observation.grading_provider_attempt) AS attempts,
    (SELECT count(*)::integer FROM observation.grade_observation) AS answers`.execute(trx)).rows[0]!);
}
async function configured(): Promise<GraderConfiguration> {
  const parsed = parseGraderConfiguration(await committedGraders());
  if (!parsed.ok) throw new Error(parsed.error.detail);
  return parsed.value;
}
/** The swap an operator makes: the same runners with another model. Only graders.json changes. */
const swapped = (configuration: GraderConfiguration): GraderConfiguration => ({ questions: configuration.questions.map((entry) =>
  ({ ...entry, graders: entry.graders.map((grader) => ({ ...grader, model: `${grader.model}-swapped` })) })) });
const pinsOf = (configuration: GraderConfiguration, question_id: string) => {
  const planned = planRegistration(configuration, oakridgeProfile.questions);
  if (!planned.ok) throw new Error(planned.error.detail);
  return planned.value.capture.pins.find((pin) => pin.question_id === question_id)!.evaluator_definition_ids;
};

async function withHarness(work: (db: Database, h: Harness, reader: ReturnType<typeof repository>) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "observation-graders-"));
  try {
    await scratchDatabase(async (db) => { const reader = repository(); await work(db, await harness(db, reader, directory), reader); });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

integration("startup registers the configured definitions and reports them, and a restart registers nothing new", async () => withHarness(async (db, h) => {
  const configuration = await configured();
  const planned = planRegistration(configuration, oakridgeProfile.questions);
  if (!planned.ok) throw new Error(planned.error.detail);
  const first = await h.start(configuration);
  const health = await (await fetch(`http://127.0.0.1:${first.port}/health`)).json() as { graders: unknown };
  expect(health.graders).toEqual({ state: "configured", graders: planned.value.graders.map((grader) =>
    ({ runner: grader.runner, evaluator_definition_id: grader.evaluator_definition_id })) });
  await first.stop();
  const registered = await counts(db);
  expect(registered).toMatchObject({ questions: oakridgeProfile.questions.length, evaluators: planned.value.evaluators.length });
  await (await h.start(configuration)).stop();
  expect(await counts(db)).toEqual(registered);
  const human = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluator_definition").selectAll().where("kind", "=", "human").execute());
  expect(human).toHaveLength(1);
}));

integration("startup refuses an unknown runner or a missing key, clearly and before registering anything", async () => withHarness(async (db) => {
  const configuration = await configured();
  const env: Record<string, string> = { ...credentialEnv(configuration), OBSERVATION_DATABASE_URL: await databaseUrl(db), OBSERVATION_PORT: "0",
    OBSERVATION_INGEST_CREDENTIALS: JSON.stringify(credentials.ingest) };
  const directory = await mkdtemp(join(tmpdir(), "observation-unknown-"));
  try {
    const graders_file = join(directory, "graders.json");
    await Bun.write(graders_file, JSON.stringify({ questions: configuration.questions.map((entry) =>
      ({ ...entry, graders: entry.graders.map((grader) => ({ ...grader, runner: "stub_model" })) })) }));
    await expect(startObservation(env, { graders_file })).rejects.toThrow("observation cannot start: unknown_runner: stub_model");
    await expect(startObservation(env, { graders_file: join(directory, "absent.json") })).rejects.toThrow("observation cannot start: invalid_graders");
  } finally { await rm(directory, { recursive: true, force: true }); }
  const { [Object.keys(credentialEnv(configuration))[0]!]: _missing, ...keyless } = env;
  await expect(startObservation(keyless)).rejects.toThrow(/observation cannot start: missing_credential: /);
  expect(await counts(db)).toMatchObject({ questions: 0, evaluators: 0 });
}));

integration("not-ready capture, config swap and restart, readiness arrival and a later capture keep each occurrence's own pins",
  async () => withHarness(async (db, h, reader) => {
  const before = await configured();
  const after = swapped(before);
  const first = await h.start(before);
  await h.send(first, launchOutcome(launch));
  await h.send(first, revisionOutcome({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") }));
  await h.send(first, revisionOutcome({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") }));
  await h.send(first, revisionOutcome({ revision_id: "assessment-1", artifact_kind: "assessment", subject_id: "build-1",
    body: await fixtureBody("assessment") }));
  const cited = await itemAt(h, first, "assessment-1", "/findings/0", "assessment_finding");
  const uncited = await itemAt(h, first, "assessment-1", "/findings/1", "assessment_finding");
  const unlinked = await itemAt(h, first, "assessment-1", "/findings/2", "assessment_finding");
  const finding = await itemAt(h, first, "analysis-1", "/findings/0", "finding");

  // Relevance is ready from the captured spec; the cited finding waits on its repository for both
  // questions; the uncited finding's Evidence support is ready while its Correctness waits for build-1.
  const relevance = question(await settled(h, first, finding, collected), RELEVANCE_ID);
  expect(relevance.readiness).toMatchObject({ state: "ready", references: [{ ref: "subject" }, { source: "run_input", ref: "spec", content: launch.spec }] });
  const citedBefore = await settled(h, first, cited, collected);
  expect(citedBefore.map((set) => [set.question_id, set.readiness.reason?.code])).toEqual([
    [CORRECTNESS_ID, "repository_unavailable"], [EVIDENCE_SUPPORT_ID, "repository_unavailable"]]);
  const uncitedBefore = await settled(h, first, uncited, collected);
  expect(question(uncitedBefore, CORRECTNESS_ID).readiness).toMatchObject({ state: "not_ready", reason: { code: "build_result_unavailable" } });
  expect(question(uncitedBefore, EVIDENCE_SUPPORT_ID).readiness).toMatchObject({ state: "ready" });
  for (const set of [...citedBefore, ...uncitedBefore]) expect(set.pinned_evaluator_definition_ids).toEqual(pinsOf(before, set.question_id));
  await first.stop();

  // The swap is a graders.json edit and a restart. Nothing already captured is repinned or regraded.
  const second = await h.start(after);
  expect((await evidenceOf(h, second, cited)).map((set) => set.pinned_evaluator_definition_ids)).toEqual(citedBefore.map((set) => set.pinned_evaluator_definition_ids));
  expect(question(await evidenceOf(h, second, uncited), EVIDENCE_SUPPORT_ID)).toEqual(question(uncitedBefore, EVIDENCE_SUPPORT_ID));

  // The missing input arrives. The waiting questions become ready under their original pins.
  reader.accessible = true;
  await h.send(second, revisionOutcome({ revision_id: "build-1", artifact_kind: "build_result", body: await fixtureBody("build-result") }));
  const citedReady = await settled(h, second, cited, (sets) => sets.every((set) => set.readiness.state === "ready"));
  expect(question(citedReady, EVIDENCE_SUPPORT_ID).readiness.references).toContainEqual(expect.objectContaining({ source: "repository",
    repository_key: "oakridge", commit_sha: HEAD, path: "src/alpha.ts", line_range: { start: 2, end: 3 }, content: "two\nthree", is_absent: false }));
  expect(question(citedReady, CORRECTNESS_ID).readiness.references).toContainEqual(expect.objectContaining({ ref: "build_result", revision_id: "build-1" }));
  expect(reader.reads.every((read) => read.startsWith(`/repos/oakridge@${HEAD}:`))).toBe(true);
  const uncitedReady = await settled(h, second, uncited, (sets) => sets.every((set) => set.readiness.state === "ready"));
  for (const set of [...citedReady, ...uncitedReady]) expect(set.pinned_evaluator_definition_ids).toEqual(pinsOf(before, set.question_id));
  expect(question(uncitedReady, EVIDENCE_SUPPORT_ID)).toEqual(question(uncitedBefore, EVIDENCE_SUPPORT_ID));

  // A later capture takes the swapped configuration.
  await h.send(second, revisionOutcome({ revision_id: "assessment-2", artifact_kind: "assessment", subject_id: "build-1",
    body: await fixtureBody("assessment") }));
  const later = await settled(h, second, await itemAt(h, second, "assessment-2", "/findings/1", "assessment_finding"), collected);
  for (const set of later) expect(set.pinned_evaluator_definition_ids).toEqual(pinsOf(after, set.question_id));
  expect(pinsOf(after, CORRECTNESS_ID)).not.toEqual(pinsOf(before, CORRECTNESS_ID));

  // A late link changes the tracking view only.
  const unlinkedReady = await settled(h, second, unlinked, (sets) => sets.every((set) => set.readiness.state === "ready"));
  const linked = await withTenant(db, tenant, (trx) => declareRelationInTransaction(trx, tenant, { run_id: "run-1", source_revision_id: "assessment-1",
    item_path: "/findings/2", link: { target: "logical_item", type: "assesses", target_scope: TASK_SCOPE, target_local_id: "T8",
      evidence_ref: "declaration:late" } }));
  expect(linked.ok).toBe(true);
  await h.send(second, revisionOutcome({ revision_id: "tasks-2", artifact_kind: "tasks", body: { tasks: [{ id: "T404", description: "Arrives late", requirement_ids: [] }] } }));
  expect(await evidenceOf(h, second, unlinked)).toEqual(unlinkedReady);
  expect(await itemAt(h, second, "assessment-1", "/findings/2", "assessment_finding")).toEqual(unlinked);
  await second.stop();

  // Both configurations' definitions are retained; nothing executed, called a provider or answered.
  const retained = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluator_definition").select("evaluator_definition_id").execute());
  const ids = retained.map((row) => row.evaluator_definition_id);
  for (const id of [...pinsOf(before, CORRECTNESS_ID), ...pinsOf(after, CORRECTNESS_ID)]) expect(ids).toContain(id);
  expect(await counts(db)).toMatchObject({ executions: 0, attempts: 0, answers: 0 });
}));

integration("a restart retries questions an earlier process left waiting", async () => withHarness(async (db, h, reader) => {
  const configuration = await configured();
  const first = await h.start(configuration);
  await h.send(first, launchOutcome(launch));
  await h.send(first, revisionOutcome({ revision_id: "assessment-1", artifact_kind: "assessment", body: await fixtureBody("assessment") }));
  const cited = await itemAt(h, first, "assessment-1", "/findings/0", "assessment_finding");
  expect((await settled(h, first, cited, collected)).every((set) => set.readiness.reason?.code === "repository_unavailable")).toBe(true);
  await first.stop();
  reader.accessible = true;
  const second = await h.start(configuration);
  const ready = await settled(h, second, cited, (sets) => sets.every((set) => set.readiness.state === "ready"));
  // An integration assessment names no build: Correctness is ready without one.
  expect(question(ready, CORRECTNESS_ID).readiness.references?.some((reference) => (reference as { ref: string }).ref === "build_result")).toBe(false);
  await second.stop();
  expect(await counts(db)).toMatchObject({ executions: 0, attempts: 0, answers: 0 });
}));

/** The provider boundary of a running service: each request is recorded with the evaluator it was made for. */
function recordingRunners(requests: string[]): RunnerResolver {
  const runner: GradeRunner = { kind: "model", async run(context, onRequest) {
    if (onRequest && !await onRequest()) return { ok: false, error: { operation: "test", entity_id: "", detail: "claim lost", category: "invalid_request" } };
    requests.push(context.evaluator.evaluator_definition_id);
    return { ok: true, value: { answer: { state: "answered", kind: "choice", value: String(context.question.allowed_values?.[0]) } } };
  } };
  return (evaluator) => evaluator.kind === "human" ? null : runner;
}
async function until<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await Bun.sleep(25);
  }
  throw new Error(`condition not reached: ${JSON.stringify(await read())}`);
}
const executionsBy = (db: Database) => withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution as x")
  .innerJoin("observation.item_occurrence as i", (join) => join.onRef("i.producer", "=", "x.producer").onRef("i.namespace", "=", "x.namespace")
    .onRef("i.occurrence_id", "=", "x.subject_occurrence_id"))
  .select(["x.execution_id", "x.status", "x.question_id", "x.evaluator_definition_id", "i.revision_id"]).orderBy("x.execution_id").execute());

integration("an enabled run grades with the evaluators pinned at capture across a swap and restarts, and never regrades",
  async () => withHarness(async (db, h, reader) => {
  const before = await configured();
  const after = swapped(before);
  const requests: string[] = [];
  const first = await h.start(before, recordingRunners(requests));
  await h.send(first, launchOutcome(launch, "run-1", runConfig(true)));
  await h.send(first, revisionOutcome({ revision_id: "assessment-1", artifact_kind: "assessment", subject_id: "build-1",
    body: await fixtureBody("assessment") }));
  // Ready questions are graded right away; the cited finding and every Correctness wait.
  const early = await until(() => executionsBy(db), (rows) => rows.length === 3 && rows.every((row) => row.status === "completed"));
  expect(early.every((row) => row.question_id === EVIDENCE_SUPPORT_ID)).toBe(true);
  await first.stop();

  const second = await h.start(after, recordingRunners(requests));
  reader.accessible = true;
  await h.send(second, revisionOutcome({ revision_id: "build-1", artifact_kind: "build_result", body: await fixtureBody("build-result") }));
  const ready = await until(() => executionsBy(db), (rows) => rows.length === 8 && rows.every((row) => row.status === "completed"));
  // The older occurrence's first answers use its original evaluators, not the swapped ones.
  for (const row of ready) expect(pinsOf(before, row.question_id)).toContain(row.evaluator_definition_id as never);
  const cited = await itemAt(h, second, "assessment-1", "/findings/0", "assessment_finding");
  const measured = await h.get(second, `/v1/items/${encodeURIComponent(cited.occurrence_id)}/status`) as {
    questions: { items: { machine: { items: { measurement: { state: string } }[] } }[] } };
  expect(measured.questions.items.flatMap((entry) => entry.machine.items.map((machine) => machine.measurement.state))).toEqual(["answered", "answered"]);

  await h.send(second, revisionOutcome({ revision_id: "assessment-2", artifact_kind: "assessment", subject_id: "build-1",
    body: await fixtureBody("assessment") }));
  const later = await until(() => executionsBy(db), (rows) => rows.length === 16 && rows.every((row) => row.status === "completed"));
  for (const row of later.filter((entry) => entry.revision_id === "assessment-2"))
    expect(pinsOf(after, row.question_id)).toContain(row.evaluator_definition_id as never);
  await second.stop();

  const sent = requests.length;
  const third = await h.start(after, recordingRunners(requests));
  await h.send(third, revisionOutcome({ revision_id: "assessment-1", artifact_kind: "assessment", subject_id: "build-1",
    body: await fixtureBody("assessment") }, tenant, "event:assessment-1-replayed"));
  await Bun.sleep(300);
  await third.stop();
  expect([(await executionsBy(db)).length, requests.length, sent]).toEqual([16, sent, 16]);
  expect(await counts(db)).toMatchObject({ executions: 16, attempts: 16, answers: 16 });
}));
