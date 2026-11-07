import { test } from "bun:test";
import { randomBytes } from "node:crypto";
import { canonicalDigest } from "canonical-json";
import { Client } from "pg";
import { sql } from "kysely";
import { configuredRunnerNames, credentialsForRunners } from "../src/grading/provider-credentials";
import { GRADERS_FILE } from "../src/main";
import type { EvaluatorDefinitionId, EvidenceSetId, ItemOccurrenceId, QuestionId } from "../src/domain/identity";
import type { JsonValue } from "../src/domain/primitives";
import { instructionDigest, type EvaluatorDefinition } from "../src/grading/evaluator";
import type { ReadyEvidence } from "../src/grading/evidence";
import type { QuestionDefinition } from "../src/grading/question";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { NO_CAPTURE_PINS, type CaptureConfiguration } from "../src/grading/evidence";
import { deliverSourceEvent } from "../src/storage/capture-store";
import { openDatabase, type Database, type TenantScope } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import type { SourceEventCursor, SourceEventDelivery, SourceEventOutcome } from "../src/ingest/cursor";
import { dropScratchDatabase } from "./database-fixture";

const serverUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
export const integration = serverUrl || process.env.CI === "true" ? test : test.skip;
export const tenant: TenantScope = { producer: "oakridge", namespace: "grading-test" };
export const SCHEMA_VERSION = "schema-1";
export const DEFINITION_ID = "definition-1";

export const question: QuestionDefinition = {
  question_id: "relevance" as QuestionId, question_version: "1", item_kind: "finding", question_text: "Is it relevant?",
  response_kind: "boolean", allowed_values: null, missing_evidence_policy: "abstain", abstain_semantics: "not enough evidence",
  unclear_semantics: "ambiguous", interpretation_caveats: "relevance is not acceptance",
};
export const evidence: ReadyEvidence = { evidence_set_id: "evidence-1" as EvidenceSetId,
  references: [{ source: "reported", reported_by: "agent", ref: "fixture", revision_id: "revision-1", item_path: "/findings/0", content: "sample" }],
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
  readonly body: JsonValue;
  readonly run_id?: string;
  readonly unit_id?: string;
  readonly subject_id?: string;
  readonly predecessor_id?: string;
  readonly recorded_at?: string;
}
export const fixtureBody = async (name: string): Promise<JsonValue> =>
  await Bun.file(new URL(`../fixtures/oakridge/${name}-revision.json`, import.meta.url)).json() as JsonValue;

const provenance = { format: "observation.source-event/v1", definition_id: DEFINITION_ID, artifact_schema_version: SCHEMA_VERSION } as const;

/** The envelope the ordered feed carries for one revision. */
export function revisionOutcome(input: FixtureRevision, scope: TenantScope = tenant, event_id = `event:${input.revision_id}`): SourceEventOutcome {
  const digest = canonicalDigest(input.body);
  if (!digest.ok) throw new Error(digest.error.detail);
  const prefix = `${scope.producer}:${scope.namespace}:`;
  const run_id = input.run_id ?? "run-1";
  return { ...provenance, kind: "artifact_revision", event_kind: "revision_published", run_id, event_id,
    revision: { format: "observation.artifact-revision/v2", source: { ...scope, revision_id: `${prefix}${input.revision_id}`, run_id,
      unit_id: input.unit_id ?? input.artifact_kind, artifact_kind: input.artifact_kind, artifact_schema_version: SCHEMA_VERSION,
      definition_id: DEFINITION_ID, predecessor_id: input.predecessor_id ? `${prefix}${input.predecessor_id}` : null,
      subject_id: input.subject_id ? `${prefix}${input.subject_id}` : null },
    recorded_at: input.recorded_at ?? "2026-11-01T00:00:00Z", body: input.body,
    body_digest: digest.value as `canonical-json/v1:${string}` & { readonly __brand: "CanonicalDigest" } } };
}

/** The launch event that captures a run's input. */
export const launchOutcome = (input: JsonValue, run_id = "run-1"): SourceEventOutcome => ({ ...provenance, kind: "run_input",
  event_kind: "launched", run_id, event_id: `launch:${run_id}`, input, input_schema_version: SCHEMA_VERSION });

export interface Feed {
  send(outcome: SourceEventOutcome, override?: CaptureConfiguration): Promise<SourceEventCursor>;
  /** A configuration override stands for a restart under an edited configuration. */
  revision(input: FixtureRevision, override?: CaptureConfiguration): Promise<SourceEventCursor>;
  launch(input: JsonValue, run_id?: string): Promise<SourceEventCursor>;
  decide(event_kind: "operator_decided", run_id?: string): Promise<SourceEventCursor>;
}

/** Drives the real ordered capture path, one acknowledged event at a time. */
export function createFeed(db: Database, scope: TenantScope = tenant, configuration: CaptureConfiguration = NO_CAPTURE_PINS): Feed {
  let cursor: SourceEventCursor = { commit_txid: "0", id: "" };
  let sequence = 0;
  const send = async (outcome: SourceEventOutcome, override: CaptureConfiguration = configuration): Promise<SourceEventCursor> => {
    const next = { commit_txid: String(++sequence), id: outcome.event_id };
    const delivery: SourceEventDelivery = { previous: cursor, cursor: next, outcome };
    const result = await deliverSourceEvent(db, scope, delivery, { extraction: oakridgeProfile.extraction, configuration: override });
    if (result.status !== 200) throw new Error(`delivery refused: ${JSON.stringify(result.body)}`);
    cursor = next;
    return cursor;
  };
  return {
    send,
    revision: (input, override) => send(revisionOutcome(input, scope), override),
    launch: (input, run_id = "run-1") => send(launchOutcome(input, run_id)),
    decide: (event_kind, run_id = "run-1") => send({ ...provenance, kind: "ignored", event_kind, run_id, event_id: `decision:${sequence}` }),
  };
}

export const occurrenceIdOf = (value: string): ItemOccurrenceId => value as ItemOccurrenceId;

/** The committed selection, read from the file the service reads. Tests take graders from here. */
export const committedGraders = async (): Promise<unknown> => Bun.file(GRADERS_FILE).json();

/** A placeholder for each setting the selection requires. The offline suite never reaches a provider. */
export function credentialEnv(graders: unknown): Record<string, string> {
  const runners = configuredRunnerNames(graders);
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
