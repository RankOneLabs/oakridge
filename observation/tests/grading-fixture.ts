import { parseGradingDefinitions, planRegistration, type GradingDefinitions } from "../src/grading/configuration";
import { test } from "bun:test";
import { randomBytes } from "node:crypto";
import { canonicalDigest } from "canonical-json";
import { Client } from "pg";
import { sql } from "kysely";
import { configuredRunnerNames, credentialsForRunners } from "../src/grading/provider-credentials";
const GRADING_FIXTURE = new URL("./fixtures/grading-definitions-test.json", import.meta.url);
import type { ArtifactRevisionId, EvaluatorDefinitionId, EvidenceSetId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import { instructionDigest, type EvaluatorDefinition } from "../src/grading/evaluator";
import type { ReadyEvidence } from "../src/grading/evidence";
import type { QuestionDefinition } from "../src/grading/question";
import { oakridgeProfile as createOakridgeProfile, oakridgeGradingRegistry } from "../src/producers/oakridge/profile";
import { NO_CAPTURE_PINS, type CaptureConfiguration } from "../src/grading/evidence";
import { deliverSourceEvent } from "../src/storage/capture-store";
import { openDatabase, type Database, type TenantScope } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { INITIAL_SOURCE_CURSOR, type RunConfigWire, type SourceEventCursor } from "../src/ingest/cursor";
import type { CommittedEventDelivery, InputBinding } from "../src/ingest/dbos-revision-delivery";
import { ARTIFACT_KEYS, ARTIFACT_KEY_LIST, type ArtifactKey } from "../src/producers/oakridge/artifact-versions";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
/** Each test creates and migrates its own scratch database, which can outrun bun's
 * 5s default when the whole suite shares one PostgreSQL server. */
export const INTEGRATION_TIMEOUT_MS = 30_000;
const databaseTest = serverUrl || process.env.CI === "true" ? test : test.skip;
export function integration(name: string, fn: () => unknown, timeout: number = INTEGRATION_TIMEOUT_MS): void {
  databaseTest(name, fn as () => Promise<unknown>, timeout);
}
export const tenant: TenantScope = { producer: "oakridge", namespace: "grading-test" };
export const SCHEMA_VERSION = "schema-1";
export const DEFINITION_ID = ARTIFACT_KEYS.development.analysis.analysis.definition_id;

export const question: QuestionDefinition = {
  question_id: "relevance" as QuestionId, question_version: "1", item_kind: "finding", question_text: "Is it relevant?",
  response_kind: "boolean", allowed_values: null, missing_evidence_policy: "abstain", abstain_semantics: "not enough evidence",
  unclear_semantics: "ambiguous", interpretation_caveats: "relevance is not acceptance",
};
export const evidence: ReadyEvidence = { evidence_set_id: "evidence-1" as EvidenceSetId,
  references: [{ source: "reported", reported_by: "agent", ref: "fixture", revision_id: "revision-1" as ArtifactRevisionId, item_path: "/findings/0", content: "sample" }],
  is_incomplete: false, incompleteness_reason: null };
export function evaluator(kind: "model" | "human", id: string = kind): EvaluatorDefinition {
  return { evaluator_definition_id: id, kind, backend_kind: "local", provider: `fixture-${id}`,
    model: kind === "model" ? "pinned" : null, instruction_text: "prompt-1", prompt_digest: instructionDigest("prompt-1"), config_digest: "config-1",
    runtime_revision: "1", cost_metadata: null, seed: null, attempt_controls: null };
}
export const evaluatorId = (id: string): EvaluatorDefinitionId => id as EvaluatorDefinitionId;

/** A fresh, isolated database holding only the target baseline. */
export async function scratchDatabase(work: (db: Database) => Promise<void>): Promise<void> {
  if (!serverUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const name = `observation_test_${randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    const db = openDatabase(url.href);
    try {
      await migrateEmptyDatabase(db);
      await work(db);
    } finally { await db.destroy(); await dropScratchDatabase(admin, name); }
  } finally { await admin.end(); }
}

export interface FixtureRevision {
  readonly revision_id: string;
  readonly artifact_kind: string;
  readonly stage?: string;
  readonly body: JsonValue;
  readonly run_id?: string;
  readonly unit_id?: string;
  readonly subject_id?: string;
  readonly input_bindings?: readonly InputBinding[];
  readonly definition_id?: string;
  readonly schema_version?: string;
  readonly predecessor_id?: string;
  readonly recorded_at?: string;
}
export const fixtureBody = async (name: string): Promise<JsonValue> =>
  await Bun.file(new URL(`../fixtures/oakridge/${name}-revision.json`, import.meta.url)).json() as JsonValue;

export const developmentKeys = {
  analysis: ARTIFACT_KEYS.development.analysis.analysis, spec: ARTIFACT_KEYS.development.analysis.spec,
  plan: ARTIFACT_KEYS.development.planning.plan, brief: ARTIFACT_KEYS.development.brief.brief,
  assessment: ARTIFACT_KEYS.development.cohort.assessment, blocker: ARTIFACT_KEYS.$core["*"].blocker,
};
export function fixtureKey(artifact: string, stage?: string, definition_id?: string): ArtifactKey | undefined {
  return ARTIFACT_KEY_LIST.find((key) => key.artifact === artifact && key.stage === stage && key.definition_id === (definition_id ?? DEFINITION_ID)) ??
    developmentKeys[artifact as keyof typeof developmentKeys];
}
export type FixtureEvent = Pick<CommittedEventDelivery, "run_id" | "event_id" | "event">;

export function revisionOutcome(input: FixtureRevision, event_id = `event:${input.revision_id}`): FixtureEvent {
  const digest = canonicalDigest(input.body);
  if (!digest.ok) throw new Error(digest.error.detail);
  const run_id = input.run_id ?? "run-1";
  const stage = input.stage ?? (input.artifact_kind === "assessment" && input.unit_id?.includes("/integration/") ? "integration" : undefined);
  const key = fixtureKey(input.artifact_kind, stage, input.definition_id);
  const artifact = input.artifact_kind;
  return { run_id, event_id, event: { kind: "revisions", revisions: [{
    revision_id: input.revision_id, run_id, artifact, body: input.body, body_digest: digest.value,
    unit_id: input.unit_id ?? artifact, stage: stage ?? (key?.stage === "*" ? "analysis" : key?.stage) ?? artifact,
    definition_id: input.definition_id ?? key?.definition_id ?? DEFINITION_ID, schema_version: input.schema_version ?? key?.schema_version ?? SCHEMA_VERSION,
    predecessor_id: input.predecessor_id ?? null, subject_id: input.subject_id ?? null,
    origin: { kind: "operator_edit" }, input_bindings: input.input_bindings ?? [],
    recorded_at: input.recorded_at ?? "2026-11-01T00:00:00Z",
  }] } };
}
export const runConfig = (grading_enabled: boolean): RunConfigWire => ({ sessions: {}, grading_enabled });
export const launchOutcome = (input: JsonValue, run_id = "run-1", config: RunConfigWire | null = null): FixtureEvent =>
  ({ run_id, event_id: `launch:${run_id}`, event: { kind: "launched", input, input_schema_version: SCHEMA_VERSION, config: config ?? runConfig(false) } });

export function fixtureDelivery(scope: TenantScope, outcome: FixtureEvent, previous: SourceEventCursor = INITIAL_SOURCE_CURSOR): CommittedEventDelivery {
  return { ...outcome, producer: "oakridge", namespace: scope.namespace, previous,
    cursor: { commit_txid: String(BigInt(previous.commit_txid) + 1n), event_id: outcome.event_id } };
}

export interface Feed {
  send(outcome: FixtureEvent, override?: CaptureConfiguration): Promise<SourceEventCursor>;
  revision(input: FixtureRevision, override?: CaptureConfiguration): Promise<SourceEventCursor>;
  launch(input: JsonValue, run_id?: string, config?: RunConfigWire | null): Promise<SourceEventCursor>;
  decide(event_kind: "operator_decided", run_id?: string): Promise<SourceEventCursor>;
}

export function createFeed(db: Database, scope: TenantScope = tenant, configuration: CaptureConfiguration = NO_CAPTURE_PINS): Feed {
  let cursor: SourceEventCursor = INITIAL_SOURCE_CURSOR;
  const send = async (outcome: FixtureEvent, override: CaptureConfiguration = configuration): Promise<SourceEventCursor> => {
    const delivery = fixtureDelivery(scope, outcome, cursor);
    const result = await deliverSourceEvent(db, scope, delivery, { extraction: oakridgeProfile.extraction, configuration: override });
    if (result.status !== 200) throw new Error(`delivery refused: ${JSON.stringify(result.body)}`);
    cursor = delivery.cursor;
    return cursor;
  };
  return {
    send,
    revision: (input, override) => send(revisionOutcome(input), override),
    launch: (input, run_id, config) => send(launchOutcome(input, run_id, config)),
    decide: (event_kind, run_id = "run-1") => send({ run_id, event_id: `decision:${cursor.commit_txid}`, event: { kind: "other", event_kind } }),
  };
}
export const occurrenceIdOf = (value: string): ItemOccurrenceId => value as ItemOccurrenceId;

/** Test-owned definitions; runtime code never reads this fixture. */
export const fixtureDefinitions = async (): Promise<GradingDefinitions> => {
  const parsed = parseGradingDefinitions(await Bun.file(GRADING_FIXTURE).json(), oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};
const committedRegistration = planRegistration(await fixtureDefinitions(), oakridgeGradingRegistry);
if (!committedRegistration.ok) throw new Error(JSON.stringify(committedRegistration.error));
export const OAKRIDGE_QUESTIONS = committedRegistration.value.questions;
export function questionVersion(question_id: string): string {
  const question = OAKRIDGE_QUESTIONS.find((question) => question.question_id === question_id);
  if (!question) throw new Error(`no committed question ${question_id}`);
  return question.question_version;
}
export const oakridgeProfile = createOakridgeProfile(OAKRIDGE_QUESTIONS, committedRegistration.value.collector);
export { oakridgeGradingRegistry };
export const COVERAGE_VALUES = OAKRIDGE_QUESTIONS.find((question) => question.question_id === "task.requirement_coverage")!.allowed_values!;

/** A placeholder for each setting the selection requires. The offline suite never reaches a provider. */
export function credentialEnv(graders: unknown): Record<string, string> {
  const runners = configuredRunnerNames(graders, oakridgeGradingRegistry);
  if (!runners.ok) throw new Error(runners.error.detail);
  const required = credentialsForRunners(runners.value);
  if (!required.ok) throw new Error(required.error.detail);
  return Object.fromEntries(required.value.required.map((name) => [name, "offline-placeholder"]));
}

/** The connection URL of a scratch database, for starting the real service on it. */
export async function databaseUrl(db: Database): Promise<string> {
  const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db);
  const url = new URL(serverUrl ?? ""); url.pathname = `/${database.rows[0]?.name ?? ""}`;
  return url.href;
}

/** The scope from the same committed definition that supplies the question version. */
export function scopeOf(question_id: string): import("../src/grading/evidence").QuestionScope {
  if (!committedRegistration.ok) throw new Error(committedRegistration.error.detail);
  const pin = committedRegistration.value.capture.pins.find((pin) => pin.question_id === question_id);
  if (!pin) throw new Error(`no scope for ${question_id}`);
  return pin.scope === "per_item" ? { scope: pin.scope } : "task_source" in pin
    ? { scope: pin.scope, task_source: pin.task_source } : { scope: pin.scope, task_ids: pin.task_ids };
}
/** The artifact, selector and item kind the committed definition targets for a question. */
export function targetOf(question_id: string): import("../src/grading/evidence").CaptureTarget {
  if (!committedRegistration.ok) throw new Error(committedRegistration.error.detail);
  const pin = committedRegistration.value.capture.pins.find((pin) => pin.question_id === question_id);
  if (!pin) throw new Error(`no target for ${question_id}`);
  return { artifact_kind: pin.artifact_kind, item_selector: pin.item_selector, item_kind: pin.item_kind };
}


export const oakridgeEvidence = committedRegistration.value.collector;
export const RELEVANCE_ID = "finding.relevance" as QuestionId;
export const CORRECTNESS_ID = "assessment_finding.correctness" as QuestionId;
export const EVIDENCE_SUPPORT_ID = "assessment_finding.evidence_support" as QuestionId;
export const TASK_COVERAGE_ID = "task.requirement_coverage" as QuestionId;
export const CONTRIBUTION_COVERAGE_ID = "acceptance_entry.task_coverage" as QuestionId;

export const pinIdentity = { config_version: 1, config_hash: "canonical-json/v1:" + "a".repeat(64) };
export const pinProvenance = (question: import("../src/grading/question").QuestionKey) => ({ ...pinIdentity, collection_plan: { question_id: question.question_id, question_version: question.question_version, evidence: committedRegistration.value.capture.pins.find((pin) => pin.question_id === question.question_id)?.collection_plan.evidence ?? [] } });
