import type { Kysely } from "kysely";
import type { DB } from "../storage/db-types";
import { readCommittedEventsAfter, readEventRevisionSequence, readEventUnitStage, readPinnedDefinition, type CommittedEventRow } from "../storage/read-store";
import type { Event } from "../core-client/core-types";
import { mapObservationEvent } from "./observation-mapping";
import { readDecisionForEvent, readOperatorRunState } from "../storage/observation-backfill-store";
import type { SourceEventAck, SourceEventCursor, SourceEventDelivery } from "./observation-wire";

export interface ObservationOptions { readonly url: string; readonly namespace: string; readonly token: string;
  readonly poll_ms?: number; readonly fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly log?: (detail: string) => void }

async function deliveryFor(db: Kysely<DB>, row: CommittedEventRow<Event>, namespace: string, previous: SourceEventCursor): Promise<SourceEventDelivery> {
  const event = row.payload;
  const definition = await readPinnedDefinition(db, row.run_id ?? "");
  const stage = event.kind === "revision_published" || event.kind === "operator_decided"
    ? await readEventUnitStage(db, row.run_id ?? "", event.unit) : null;
  const sequence = event.kind === "revision_published" ? await readEventRevisionSequence(db, row, event.artifact) : null;
  const matched = event.kind === "operator_decided"
    ? await readDecisionForEvent(db, row.run_id ?? "", event, row.created_at) : null;
  const outcome = mapObservationEvent({ row, definition, namespace, stage, revision_sequence: sequence,
    decision_effect: matched?.effect ?? null, decision_created_at: matched?.created_at, decision_id: matched?.id ?? null });
  return { previous, cursor: { commit_txid: row.commit_txid, id: row.id }, outcome };
}

async function serviceCursor(options: ObservationOptions, signal?: AbortSignal): Promise<SourceEventCursor> {
  const response = await (options.fetcher ?? fetch)(new URL("/v1/sources/oakridge/cursor", options.url),
    { headers: { authorization: `Bearer ${options.token}` }, signal });
  if (!response.ok) throw new Error(`observation cursor HTTP ${response.status}`);
  const ack = await response.json() as SourceEventAck;
  if (!ack.cursor || !/^[0-9]+$/.test(ack.cursor.commit_txid) || typeof ack.cursor.id !== "string") throw new Error("invalid observation cursor response");
  return ack.cursor;
}

/** One read and one acknowledged delivery; the service's cursor is always authoritative. */
export async function publishObservationOnce(db: Kysely<DB>, options: ObservationOptions, signal?: AbortSignal): Promise<boolean> {
  const previous = await serviceCursor(options, signal);
  const [row] = await readCommittedEventsAfter(db, "authority.event", { after: previous, limit: 1 });
  if (!row) return false;
  const delivery = await deliveryFor(db, row, options.namespace, previous);
  const response = await (options.fetcher ?? fetch)(new URL("/v1/sources/oakridge/events", options.url), {
    method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
    body: JSON.stringify(delivery), signal,
  });
  if (!response.ok) throw new Error(`observation delivery HTTP ${response.status}`);
  const ack = await response.json() as SourceEventAck;
  if (ack.cursor?.commit_txid !== delivery.cursor.commit_txid || ack.cursor.id !== delivery.cursor.id)
    throw new Error("observation acknowledged a different cursor");
  return true;
}

/** Scan the separate operator stream. Oakridge itself confirms run absence. */
export async function publishObservationOperatorOnce(db: Kysely<DB>, options: ObservationOptions, signal?: AbortSignal): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  const headers = { authorization: `Bearer ${options.token}` };
  const response = await fetcher(new URL("/v1/sources/oakridge/operator-cursor", options.url), { headers, signal });
  if (!response.ok) throw new Error(`observation operator cursor HTTP ${response.status}`);
  const ack = await response.json() as SourceEventAck;
  if (!ack.cursor || !/^[0-9]+$/.test(ack.cursor.commit_txid) || typeof ack.cursor.id !== "string")
    throw new Error("invalid observation operator cursor response");
  const previous = ack.cursor;
  const [row] = await readCommittedEventsAfter(db, "authority.operator_event", { after: previous, limit: 1 });
  if (!row) return false;
  const details = await readOperatorRunState(db, row.id);
  const delivery = { previous, cursor: { commit_txid: row.commit_txid, id: row.id }, event: {
    id: row.id, run_key: details.run_key, payload: row.payload, run_exists: details.run_exists, operator_override: false } };
  const posted = await fetcher(new URL("/v1/sources/oakridge/operator-events", options.url), { method: "POST",
    headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(delivery), signal });
  if (!posted.ok) throw new Error(`observation operator event HTTP ${posted.status}`);
  const result = await posted.json() as SourceEventAck;
  if (result.cursor?.commit_txid !== delivery.cursor.commit_txid || result.cursor.id !== delivery.cursor.id)
    throw new Error("observation acknowledged a different operator cursor");
  return true;
}

export interface ObservationPublisher { stop(): Promise<void> }
/** The publisher never enters commit, step or effect execution. */
export function startObservationPublisher(db: Kysely<DB>, options: ObservationOptions): ObservationPublisher {
  const controller = new AbortController();
  const log = options.log ?? ((detail: string) => console.warn(detail));
  const wait = (): Promise<void> => new Promise((resolve) => {
    const done = (): void => { controller.signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(done, options.poll_ms ?? 500);
    const abort = (): void => { clearTimeout(timer); done(); };
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  const running = (async () => {
    while (!controller.signal.aborted) {
      try {
        const published = await publishObservationOnce(db, options, controller.signal);
        const operatorPublished = await publishObservationOperatorOnce(db, options, controller.signal);
        if (!published && !operatorPublished) await wait();
      }
      catch (cause) {
        if (!controller.signal.aborted) { log(`observation publisher: ${cause instanceof Error ? cause.message : String(cause)}`); await wait(); }
      }
    }
  })();
  return { async stop() { controller.abort(); await running; } };
}
