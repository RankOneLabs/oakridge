import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import type { JsonValue } from "../src/domain/primitives";
import { parseGradingDefinitions, planRegistration, type GradingDefinitions } from "../src/grading/configuration";
import type { EvidenceSet } from "../src/grading/evidence";
import type { SourceEventCursor, SourceEventOutcome } from "../src/ingest/cursor";
import type { RepositoryFile, RepositoryReader } from "../src/ports/artifact-source";
import { TASK_SCOPE } from "../src/producers/oakridge/catalogue";
import { CORRECTNESS_ID, EVIDENCE_SUPPORT_ID, RELEVANCE_ID } from "./grading-fixture";
import { oakridgeProfile, oakridgeGradingRegistry } from "./grading-fixture";
import { createGradingConfigStore } from "../src/grading/configuration-store";
import { createGradingPublication } from "../src/grading/publication";
import { RuntimeConfiguration, runtimeSnapshot } from "../src/grading/runtime-configuration";
import { oakridgeProfile as createProfile } from "../src/producers/oakridge/profile";
import { startObservation } from "../src/main";
import type { RunnerResolver } from "../src/grading/worker";
import type { GradeRunner } from "../src/ports/grade-runner";
import { withTenant, type Database } from "../src/storage/database";
import { registerQuestion } from "../src/storage/grading-store";
import { declareRelationInTransaction } from "../src/storage/projection-store";
import { fixtureDefinitions, credentialEnv, databaseUrl, fixtureBody, integration, launchOutcome, revisionOutcome, runConfig, scratchDatabase,
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
  start(graders: GradingDefinitions | unknown, runners?: RunnerResolver): Promise<Service>;
  publish(service: Service, definitions: GradingDefinitions): Promise<void>;
  send(service: Service, outcome: SourceEventOutcome): Promise<void>;
  get(service: Service, path: string): Promise<unknown>;
}
async function harness(db: Database, reader: RepositoryReader, directory: string): Promise<Harness> {
  let cursor: SourceEventCursor = { commit_txid: "0", id: "" };
  const url = await databaseUrl(db);
  return {
    async start(graders, runners) {
      const grading_config_dir = directory;
      const store = createGradingConfigStore(directory);
      const empty = planRegistration([], oakridgeGradingRegistry);
      if (!empty.ok) throw new Error(empty.error.detail);
      const runtime = new RuntimeConfiguration(runtimeSnapshot({ version: null, hash: null, registration: empty.value,
        profile: createProfile([], empty.value.collector), applied_at: new Date().toISOString() }));
      const publication = createGradingPublication({ db, store, runtime, registry: oakridgeGradingRegistry, credentials,
        env: credentialEnv(graders), profile: (registration) => createProfile(registration.questions, registration.collector) });
      const draft = await store.readDraft();
      if (!draft.ok) throw new Error(draft.error.detail);
      const saved = await store.saveDraft(draft.value?.digest ?? null, { status: "draft", definitions: graders as JsonValue[] });
      const latest = await store.latestVersion();
      if (!saved.ok || !latest.ok) throw new Error("cannot prepare store");
      const published = await publication.publish({ expected_draft_digest: saved.value.digest, expected_latest_version: latest.value?.version ?? null });
      if (!published.ok) throw new Error(published.error.detail);
      return startObservation({ ...credentialEnv(graders), OBSERVATION_DATABASE_URL: url, OBSERVATION_PORT: "0",
        OBSERVATION_INGEST_CREDENTIALS: JSON.stringify(credentials.ingest), OBSERVATION_READ_CREDENTIALS: JSON.stringify(credentials.read),
        OBSERVATION_GRADE_CREDENTIALS: JSON.stringify(credentials.grade), OBSERVATION_CONFIGURE_CREDENTIALS: JSON.stringify([{ token: "configure-secret" }]) }, { grading_config_dir, repository: reader, runners, worker_idle_ms: 20 });
    },
    async publish(service, definitions) {
      const headers = { authorization: "Bearer configure-secret", "content-type": "application/json" };
      const base = `http://127.0.0.1:${service.port}/v1/grading-config`;
      const draft = await (await fetch(`${base}/draft`, { headers })).json() as { digest: string } | null;
      const versions = await (await fetch(`${base}/versions`, { headers })).json() as { versions: { version: number }[] };
      const saved = await (await fetch(`${base}/draft`, { method: "PUT", headers,
        body: JSON.stringify({ expected_draft_digest: draft?.digest ?? null, document: { status: "draft", definitions } }) })).json() as { digest: string };
      const response = await fetch(`${base}/publish`, { method: "POST", headers, body: JSON.stringify({ expected_draft_digest: saved.digest,
        expected_latest_version: versions.versions.at(-1)?.version ?? null }) });
      expect(response.status).toBe(201);
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
    .filter((set) => set.task_id === null || set.task_id.endsWith(":T7"))
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
async function configured(): Promise<GradingDefinitions> {
  const parsed = parseGradingDefinitions(await fixtureDefinitions(), oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  return parsed.value;
}
/** The swap an operator makes: the same runners with another model. Only the published configuration changes. */
const swapped = (configuration: GradingDefinitions): GradingDefinitions => configuration.map((entry) =>
  ({ ...entry, evaluators: entry.evaluators.map((grader) => "model" in grader ? { ...grader, model: `${grader.model}-swapped` } : grader) }));
const pinsOf = (configuration: GradingDefinitions, question_id: string) => {
  const planned = planRegistration(configuration, oakridgeGradingRegistry);
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
  const planned = planRegistration(configuration, oakridgeGradingRegistry);
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

test("startup requires an explicit configuration directory", async () => {
  await expect(startObservation({ OBSERVATION_DATABASE_URL: "postgres://unused" })).rejects.toThrow("OBSERVATION_GRADING_CONFIG_DIR is required");
});
integration("an empty store registers nothing and reports no configured graders", async () => scratchDatabase(async (db) => {
  const directory = await mkdtemp(join(tmpdir(), "observation-empty-"));
  try {
    const service = await startObservation({ OBSERVATION_DATABASE_URL: await databaseUrl(db), OBSERVATION_PORT: "0", OBSERVATION_GRADING_CONFIG_DIR: directory,
      OBSERVATION_CONFIGURE_CREDENTIALS: '[{"token":"configure"}]' });
    try {
      expect(await (await fetch(`http://127.0.0.1:${service.port}/health`)).json()).toMatchObject({ graders: { state: "none_configured" } });
      expect(await (await fetch(`http://127.0.0.1:${service.port}/v1/grading-config/runtime`, { headers: { authorization: "Bearer configure" } })).json())
        .toMatchObject({ version: null, hash: null, graders: { state: "none_configured" } });
    }
    finally { await service.stop(); }
    expect(await counts(db)).toMatchObject({ questions: 0, evaluators: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}));
integration("startup fails on the latest version with its identity and never falls back", async () => withHarness(async (db) => {
  const definitions = await configured();
  const directory = await mkdtemp(join(tmpdir(), "observation-fail-fast-"));
  const env = { ...credentialEnv(definitions), OBSERVATION_DATABASE_URL: await databaseUrl(db), OBSERVATION_PORT: "0", OBSERVATION_GRADING_CONFIG_DIR: directory };
  try {
    const store = createGradingConfigStore(directory);
    const first = await store.allocateAndWritePublished({ definitions, published_at: new Date().toISOString() });
    if (!first.ok) throw new Error(first.error.detail);
    for (const [kind, changed] of [
      ["unknown_runner", definitions.map((entry) => ({ ...entry, evaluators: entry.evaluators.map((grader) => ("model" in grader ? { ...grader, runner: "stub_model" } : grader)) }))],
      ["unknown_capability", definitions.map((entry) => ({ ...entry, evidence: ["absent_capability"] }))],
    ] as const) {
      const saved = await store.allocateAndWritePublished({ definitions: changed, published_at: new Date().toISOString() });
      if (!saved.ok) throw new Error(saved.error.detail);
      await expect(startObservation(env)).rejects.toThrow(`observation cannot start: grading configuration version ${saved.value.version} (hash ${saved.value.hash}): ${kind}:`);
    }
    const saved = await store.allocateAndWritePublished({ definitions, published_at: new Date().toISOString() });
    if (!saved.ok) throw new Error(saved.error.detail);
    await expect(startObservation({ ...env, ...Object.fromEntries(Object.keys(credentialEnv(definitions)).map((key) => [key, ""])) }))
      .rejects.toThrow(`observation cannot start: grading configuration version ${saved.value.version} (hash ${saved.value.hash}): missing_credential:`);
    await Bun.write(join(directory, "versions/000005.json"), JSON.stringify({ ...saved.value, version: 5, definitions: [{}] }));
    await expect(startObservation(env)).rejects.toThrow(`observation cannot start: grading configuration version 5 (hash ${saved.value.hash}): invalid_document:`);
    expect(await counts(db)).toMatchObject({ questions: 0, evaluators: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
}));

integration("not-ready capture, config swap and restart, readiness arrival and a later capture keep each occurrence's own pins",
  async () => withHarness(async (db, h, reader) => {
  const before = await configured();
  const after = swapped(before);
  const first = await h.start(before);
  await h.send(first, launchOutcome(launch));
  await h.send(first, revisionOutcome({ revision_id: "analysis-1", artifact_kind: "analysis", body: await fixtureBody("analysis") }));
  await h.send(first, revisionOutcome({ revision_id: "tasks-1", artifact_kind: "tasks", body: await fixtureBody("tasks") }));
  await h.send(first, revisionOutcome({ revision_id: "tasks-context", artifact_kind: "tasks", body: { tasks: ["T7", "T8"].map((id) => ({ id, description: id, requirement_ids: ["unavailable"] })) } }));
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
    [CORRECTNESS_ID, "build_result_unavailable"], [EVIDENCE_SUPPORT_ID, "repository_unavailable"]]);
  const uncitedBefore = await settled(h, first, uncited, collected);
  expect(question(uncitedBefore, CORRECTNESS_ID).readiness).toMatchObject({ state: "not_ready", reason: { code: "build_result_unavailable" } });
  expect(question(uncitedBefore, EVIDENCE_SUPPORT_ID).readiness).toMatchObject({ state: "ready" });
  for (const set of [...citedBefore, ...uncitedBefore]) expect(set.pinned_evaluator_definition_ids).toEqual(pinsOf(before, set.question_id));
  await first.stop();

  // The swap is a publication followed by a restart. Nothing already captured is repinned or regraded.
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
  await h.send(first, revisionOutcome({ revision_id: "tasks-context", artifact_kind: "tasks", body: { tasks: ["T7", "T8"].map((id) => ({ id, description: id, requirement_ids: ["unavailable"] })) } }));
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
  await h.send(first, revisionOutcome({ revision_id: "tasks-context", artifact_kind: "tasks", body: { tasks: ["T7", "T8"].map((id) => ({ id, description: id, requirement_ids: ["unavailable"] })) } }));
  await h.send(first, revisionOutcome({ revision_id: "assessment-1", artifact_kind: "assessment", subject_id: "build-1",
    body: await fixtureBody("assessment") }));
  // Ready questions are graded right away; the cited finding and every Correctness wait.
  const early = await until(() => executionsBy(db), (rows) => rows.length === 2 && rows.every((row) => row.status === "completed"));
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
  expect(measured.questions.items.flatMap((entry) => entry.machine.items.map((machine) => machine.measurement.state))).toEqual(["answered", "answered", "answered", "answered"]);

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

for (const edit of ["wording", "targets"] as const) integration(`waiting subjects retain their collection plan across a ${edit} edit and process restart`, async () => withHarness(async (db, h, reader) => {
  const before = (await configured()).filter((entry) => entry.id === "acceptance_entry.task_coverage");
  const original = before[0]!;
  const after: GradingDefinitions = [{ ...original, evidence: ["subject"],
    ...(edit === "wording" ? { question: { ...original.question, text: "Reworded coverage question" } }
      : { targets: original.targets.filter((target) => target.artifact === "plan") }) }];
  const requests: string[] = [];
  let service: Service | null = null;
  try {
    service = await h.start(before, recordingRunners(requests));
    await h.send(service, launchOutcome(launch, "run-1", runConfig(true)));
    await h.send(service, revisionOutcome({ revision_id: "plan-original", artifact_kind: "plan", body: { cohorts: [], risks: [] }, recorded_at: "2026-11-01T00:00:00Z" }));
    await h.send(service, revisionOutcome({ revision_id: "brief-original", artifact_kind: "brief", recorded_at: "2026-11-01T00:00:02Z",
      body: { cohort_id: "api", decisions_made: [], approaches_rejected: [], acceptance_criteria: [{ id: "T1", text: "Ship reads", decision_ids: [] }] } }));
    const item = await itemAt(h, service, "brief-original", "/acceptance_criteria/0", "acceptance_entry");
    const [pinned] = await settled(h, service, item, collected);
    expect(pinned!.readiness).toMatchObject({ state: "not_ready", reason: { code: "task_unavailable" } });
    const original_plan = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set").select("collection_plan")
      .where("evidence_set_id", "=", pinned!.evidence_set_id).executeTakeFirstOrThrow());
    expect(original_plan.collection_plan).toMatchObject({ question_version: pinned!.question_version, evidence: original.evidence });
    await expect(withTenant(db, tenant, (trx) => sql`UPDATE observation.evidence_set SET collection_plan = NULL
      WHERE evidence_set_id = ${pinned!.evidence_set_id}`.execute(trx))).rejects.toThrow("pin is immutable");
    await service.stop(); service = null;

    // A fresh process knows only the edited configuration, including a different evidence list.
    service = await h.start(after, recordingRunners(requests));
    reader.accessible = true;
    await h.send(service, revisionOutcome({ revision_id: "tasks-original", artifact_kind: "tasks", recorded_at: "2026-11-01T00:00:01Z",
      body: { tasks: [{ id: "T1", description: "Ship reads", requirement_ids: [] }] } }));
    const [ready] = await settled(h, service, item, (sets) => sets.length === 1 && sets.every((set) => set.readiness.state === "ready"));
    expect(ready).toMatchObject({ evidence_set_id: pinned!.evidence_set_id, question_version: pinned!.question_version,
      pinned_evaluator_definition_ids: pinned!.pinned_evaluator_definition_ids });
    expect(ready!.readiness.references?.map((ref) => (ref as { ref: string }).ref))
      .toEqual(["subject", "spec", "spec_task", "plan", "contribution_context"]);
    const completed = await until(() => executionsBy(db), (rows) => rows.length === 1 && rows[0]!.status === "completed");
    expect(completed[0]!.evaluator_definition_id).toBe(pinsOf(before, original.id)[0]!);
    expect(requests).toHaveLength(1);
    const response = await fetch(`http://127.0.0.1:${service.port}/v1/items/${encodeURIComponent(item.occurrence_id)}/answers`, {
      method: "POST", headers: { authorization: "Bearer grade-secret", "content-type": "application/json" },
      body: JSON.stringify({ question_id: original.id, question_version: pinned!.question_version,
        submission_id: `old-plan-${edit}`, answer: "fully_covers", task_id: null }),
    });
    expect(response.status).toBe(201);
  } finally { await service?.stop(); }
}));

integration("runtime publication changes new captures without restarting and preserves earlier pins and grades byte for byte", async () => withHarness(async (db, h) => {
  const before = await configured();
  const after = swapped(before);
  const requests: string[] = [];
  const service = await h.start(before, recordingRunners(requests));
  const runtime = async () => (await fetch(`http://127.0.0.1:${service.port}/v1/grading-config/runtime`, {
    headers: { authorization: "Bearer configure-secret" } })).json() as Promise<{ hash: string; version: number }>;
  const history = () => withTenant(db, tenant, async (trx) => (await sql<{ snapshot: string }>`SELECT jsonb_build_object(
    'pins', (SELECT jsonb_agg(to_jsonb(e) ORDER BY evidence_set_id) FROM observation.evidence_set e
      JOIN observation.item_occurrence i ON (i.producer, i.namespace, i.occurrence_id) = (e.producer, e.namespace, e.subject_occurrence_id) WHERE i.revision_id = 'analysis-before'),
    'grades', (SELECT jsonb_agg(to_jsonb(g) ORDER BY observation_id) FROM observation.grade_observation g
      JOIN observation.evaluation_execution x USING (producer, namespace, execution_id)
      JOIN observation.item_occurrence i ON (i.producer, i.namespace, i.occurrence_id) = (x.producer, x.namespace, x.subject_occurrence_id) WHERE i.revision_id = 'analysis-before'))::text AS snapshot`.execute(trx)).rows[0]!.snapshot);
  try {
    await h.send(service, launchOutcome(launch, "run-1", runConfig(true)));
    await h.send(service, revisionOutcome({ revision_id: "analysis-before", artifact_kind: "analysis", body: await fixtureBody("analysis") }));
    await until(() => executionsBy(db), (rows) => rows.length > 0 && rows.every((row) => row.status === "completed"));
    const frozen = await history();
    const old = await runtime();
    const pid = process.pid;
    await h.publish(service, after);
    const refreshed = await runtime();
    expect([refreshed.version, refreshed.hash !== old.hash, process.pid]).toEqual([old.version + 1, true, pid]);
    expect(await history()).toBe(frozen);
    await h.send(service, revisionOutcome({ revision_id: "analysis-after", artifact_kind: "analysis", body: await fixtureBody("analysis") }));
    const rows = await until(() => executionsBy(db), (rows) => rows.some((row) => row.revision_id === "analysis-after") && rows.every((row) => row.status === "completed"));
    for (const row of rows.filter((row) => row.revision_id === "analysis-after")) expect(pinsOf(after, row.question_id)).toContain(row.evaluator_definition_id as never);
    expect(await history()).toBe(frozen);
  } finally { await service.stop(); }
}));

integration("startup registration failure names the latest version and hash", async () => scratchDatabase(async (db) => {
  const definitions = await configured();
  const directory = await mkdtemp(join(tmpdir(), "observation-register-failure-"));
  try {
    const store = createGradingConfigStore(directory);
    const published = await store.allocateAndWritePublished({ definitions, published_at: new Date().toISOString() });
    if (!published.ok) throw new Error(published.error.detail);
    const planned = planRegistration(definitions, oakridgeGradingRegistry);
    if (!planned.ok) throw new Error(planned.error.detail);
    const question = planned.value.questions[0]!;
    const inserted = await registerQuestion(db, tenant, { ...question, question_text: "Conflicting immutable definition" });
    expect(inserted.ok).toBe(true);
    await expect(startObservation({ ...credentialEnv(definitions), OBSERVATION_DATABASE_URL: await databaseUrl(db), OBSERVATION_PORT: "0",
      OBSERVATION_GRADING_CONFIG_DIR: directory, OBSERVATION_READ_CREDENTIALS: JSON.stringify([{ ...tenant, token: "read" }]) }))
      .rejects.toThrow(`observation cannot start: grading configuration version 1 (hash ${published.value.hash}): registration_failed: ${question.question_id}: question definition identity conflict`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}));
