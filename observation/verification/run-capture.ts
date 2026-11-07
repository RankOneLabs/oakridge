/**
 * Whether the ordered feed holds one run. A healthy DBOS and kbbl prove nothing
 * here: the authority's events for the run are compared one by one with what the
 * service recorded, and the target revision is read back through the service.
 */
import { z } from "zod";
import { err, ok, type Result } from "../src/domain/primitives";
import type { ProofCheck, ProofFailure, RunCapture, RunCaptureRequest, UnmappedEvent } from "./proof-contract";
import { observationFacts, type ProofIo } from "./shadow-session";

const POLL_MS = 1_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 120_000;
const PRODUCER = "oakridge";

const authorityEventsSchema = z.array(z.object({ id: z.string(), commit_txid: z.string(), kind: z.string(), artifact: z.string().nullable() }));
const outcomesSchema = z.array(z.object({ event_id: z.string(), event_kind: z.string(), outcome_kind: z.string(),
  reason: z.string().nullable(), revision_id: z.string().nullable() }));
const cursorSchema = z.object({ cursor: z.object({ commit_txid: z.string(), id: z.string() }) });
const servedRevisionSchema = z.object({ revision_id: z.string(), run_id: z.string(), artifact_kind: z.string() });
type AuthorityEvent = z.infer<typeof authorityEventsSchema>[number];
type Outcome = z.infer<typeof outcomesSchema>[number];
type SourceCursor = z.infer<typeof cursorSchema>["cursor"];

const position = (cursor: { readonly commit_txid: string; readonly id: string }): string => `${cursor.commit_txid}/${cursor.id}`;
const reachedEvent = (cursor: SourceCursor, event: AuthorityEvent): boolean =>
  BigInt(cursor.commit_txid) > BigInt(event.commit_txid) || cursor.commit_txid === event.commit_txid && cursor.id >= event.id;

async function readRows<Row>(io: ProofIo, database: string, query: string, schema: z.ZodType<Row[]>): Promise<Result<Row[], ProofFailure>> {
  const text = await io.shadowQuery(database, query);
  if (!text.ok) return text;
  try {
    const parsed = schema.safeParse(JSON.parse(text.value));
    return parsed.success ? ok(parsed.data) : err({ operation: "read_run_capture", entity_id: database, detail: "unexpected row shape" });
  } catch { return err({ operation: "read_run_capture", entity_id: database, detail: "unreadable query result" }); }
}

const readAuthorityEvents = (io: ProofIo, run_id: string) => readRows(io, io.state.postgres.authority_database,
  `SELECT coalesce(json_agg(json_build_object('id', id, 'commit_txid', commit_txid::text, 'kind', payload->>'kind', 'artifact', payload->>'artifact')
    ORDER BY commit_txid, id), '[]') FROM authority.event WHERE run_id = '${run_id}'`, authorityEventsSchema);

const readOutcomes = (io: ProofIo, run_id: string) => readRows(io, io.state.observation.database,
  `SELECT coalesce(json_agg(json_build_object('event_id', event_id, 'event_kind', event_kind, 'outcome_kind', outcome_kind,
    'reason', detail->>'reason', 'revision_id', detail->'revision'->'source'->>'revision_id') ORDER BY commit_txid, event_id), '[]')
    FROM observation.source_event_outcome WHERE producer = '${PRODUCER}' AND namespace = '${io.state.observation.namespace}' AND run_id = '${run_id}'`, outcomesSchema);

async function readCursor(io: ProofIo): Promise<Result<SourceCursor, ProofFailure>> {
  const read = await io.observationGet(`/v1/sources/${PRODUCER}/cursor`, "ingest");
  if (!read.ok) return read;
  const parsed = cursorSchema.safeParse(read.value);
  return parsed.success ? ok(parsed.data.cursor) : err({ operation: "read_run_capture", entity_id: "cursor", detail: "unexpected cursor shape" });
}

/** The newest published revision of the target, as the service recorded it. */
function targetRevisionId(request: RunCaptureRequest, events: readonly AuthorityEvent[], outcomes: readonly Outcome[]): string | null {
  const published = events.findLast((event) => event.kind === "revision_published" && event.artifact === request.target_artifact);
  return outcomes.find((outcome) => outcome.event_id === published?.id)?.revision_id ?? null;
}

async function readServedRevision(io: ProofIo, request: RunCaptureRequest, revision_id: string): Promise<Result<string, ProofFailure>> {
  const read = await io.observationGet(`/v1/source-revisions/${encodeURIComponent(revision_id)}`, "read");
  if (!read.ok) return read;
  const parsed = servedRevisionSchema.safeParse(read.value);
  return parsed.success && parsed.data.run_id === request.run_id && parsed.data.artifact_kind === request.target_artifact
    ? ok(parsed.data.revision_id) : err({ operation: "read_run_capture", entity_id: revision_id, detail: "the service returned a different revision" });
}

const failureOf = (result: Result<unknown, ProofFailure>): readonly string[] => result.ok ? [] : [`${result.error.operation}: ${result.error.detail}`];

/** One comparison of the authority with the feed; a read that fails leaves its side empty. */
export async function readRunCapture(io: ProofIo, request: RunCaptureRequest): Promise<RunCapture> {
  const [events, outcomes, cursor] = [await readAuthorityEvents(io, request.run_id), await readOutcomes(io, request.run_id), await readCursor(io)];
  const authority = events.ok ? events.value : [];
  const delivered = outcomes.ok ? outcomes.value : [];
  const delivered_ids = new Set(delivered.map((outcome) => outcome.event_id));
  const last = authority.at(-1) ?? null;
  const unmapped: readonly UnmappedEvent[] = delivered.filter((outcome) => outcome.outcome_kind === "unmapped")
    .map(({ event_id, event_kind, reason }) => ({ event_id, event_kind, reason: reason ?? "no reason recorded" }));
  const target_id = request.target_artifact === null ? null : targetRevisionId(request, authority, delivered);
  const served = target_id === null ? null : await readServedRevision(io, request, target_id);
  return { ...request, authority_events: authority.length, delivered_events: authority.filter((event) => delivered_ids.has(event.id)).length,
    authority_last: last ? position(last) : null, service_cursor: cursor.ok ? position(cursor.value) : null,
    cursor_reached_run: cursor.ok && last !== null && reachedEvent(cursor.value, last),
    undelivered_event_ids: authority.filter((event) => !delivered_ids.has(event.id)).map((event) => event.id), unmapped,
    source_revisions: delivered.flatMap((outcome) => outcome.revision_id ?? []), target_revision: served?.ok ? served.value : null,
    read_failures: [...failureOf(events), ...failureOf(outcomes), ...failureOf(cursor), ...(served ? failureOf(served) : [])], diagnostics: null };
}

const allDelivered = (capture: RunCapture): boolean =>
  capture.authority_events > 0 && capture.undelivered_event_ids.length === 0 && capture.cursor_reached_run;
const allMapped = (capture: RunCapture): boolean => capture.delivered_events > 0 && capture.unmapped.length === 0;
const targetServed = (capture: RunCapture): boolean => capture.target_artifact === null || capture.target_revision !== null;

/** A run with no authority events, or a read that failed, is never captured. */
export const isRunCaptured = (capture: RunCapture): boolean => allDelivered(capture) && allMapped(capture) && targetServed(capture);

/**
 * Waits for the feed to cover the run, within the timeout plus one bounded read.
 * An unmapped outcome is permanent, so the wait ends there. Whatever the result,
 * the capture carries what observation and the publisher said at the end.
 */
export async function awaitRunCapture(io: ProofIo, request: RunCaptureRequest, timeout_ms = DEFAULT_CAPTURE_TIMEOUT_MS): Promise<RunCapture> {
  const deadline = io.now() + timeout_ms;
  let capture = await readRunCapture(io, request);
  while (!isRunCaptured(capture) && capture.unmapped.length === 0 && io.now() < deadline) {
    await io.sleep(POLL_MS);
    capture = await readRunCapture(io, request);
  }
  const facts = observationFacts(await io.kbblHealth(), await io.observationStatus());
  return { ...capture, diagnostics: { ...facts, publisher_failures: await io.publisherFailures() } };
}

function failureDetail(capture: RunCapture): string {
  const { diagnostics, read_failures } = capture;
  return [...read_failures, ...(diagnostics ? [`health ${diagnostics.health}`, `launcher ${diagnostics.launcher}`, ...diagnostics.publisher_failures] : [])].join("; ");
}

export function runCaptureChecks(capture: RunCapture): readonly ProofCheck[] {
  const detail = (passed: boolean, summary: string): string => passed ? summary : [summary, failureDetail(capture)].filter(Boolean).join("; ");
  const delivered = allDelivered(capture);
  const mapped = allMapped(capture);
  const served = targetServed(capture);
  return [
    { name: "the ordered feed delivered every event of the run", passed: delivered,
      detail: detail(delivered, `${capture.delivered_events} of ${capture.authority_events} events; cursor ${capture.service_cursor}, run's last event ${capture.authority_last}`) },
    { name: "the service mapped every event of the run", passed: mapped, detail: detail(mapped, `${capture.unmapped.length} unmapped: ${JSON.stringify(capture.unmapped)}`) },
    ...(capture.target_artifact === null ? [] : [{ name: "the service serves the target revision", passed: served,
      detail: detail(served, `${capture.target_artifact}: ${capture.target_revision}`) }]),
  ];
}
