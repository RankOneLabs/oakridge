import type { Kysely } from "kysely";
import type { DB } from "../storage/db-types";
import { readCommittedEventsAfter, readCommittedRunConfig, readDeliveredRevisions, readPinnedDefinition, type CommittedEventRow } from "../storage/read-store";
import type { CoreEvent } from "../storage/json-column-types";
import { selectEventDelivery, type DeliveryAck, type DeliveryCursor, type CommittedEventDelivery } from "./revision-delivery";

export interface ObservationOptions { readonly url: string; readonly namespace: string; readonly token: string; readonly read_token?: string | null;
  readonly poll_ms?: number; readonly fetcher?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly log?: (detail: string) => void }

interface DeliveryRequest {
  readonly row: CommittedEventRow<CoreEvent>;
  readonly namespace: string;
  readonly previous: DeliveryCursor;
}

async function deliveryFor(db: Kysely<DB>, { row, namespace, previous }: DeliveryRequest): Promise<CommittedEventDelivery> {
  const run_id = row.run_id ?? "";
  const revisions = await readDeliveredRevisions(db, run_id, row.id);
  const launched = row.payload.kind === "launched";
  const definition = launched || revisions.length ? await readPinnedDefinition(db, run_id) : null;
  const committed = launched ? await readCommittedRunConfig(db, run_id) : null;
  if (committed?.state === "malformed") throw new Error(`Malformed committed config for run ${run_id}`);
  const config = committed?.state === "committed"
    ? { sessions: committed.config.sessions, grading_enabled: committed.config.grading_enabled } : { sessions: {}, grading_enabled: false };
  const selected = selectEventDelivery({ row: { ...row, namespace, previous, config }, deliveries: revisions, revisions, definition });
  if (!selected.ok) {
    const { operation, entity_id, detail } = selected.error;
    throw new Error(`${operation}: ${entity_id}: ${detail}`);
  }
  return selected.value;
}

async function serviceCursor(options: ObservationOptions, signal?: AbortSignal): Promise<DeliveryCursor> {
  const response = await (options.fetcher ?? fetch)(new URL("/v1/sources/oakridge/cursor", options.url),
    { headers: { authorization: `Bearer ${options.token}` }, signal });
  if (!response.ok) throw new Error(`observation cursor HTTP ${response.status}`);
  const ack = await response.json() as DeliveryAck;
  if (!ack.cursor || !/^[0-9]+$/.test(ack.cursor.commit_txid) || typeof ack.cursor.event_id !== "string") throw new Error("invalid observation cursor response");
  return ack.cursor;
}

/** One read and one acknowledged delivery; the service's cursor is always authoritative. */
export async function publishObservationOnce(db: Kysely<DB>, options: ObservationOptions, signal?: AbortSignal): Promise<boolean> {
  const previous = await serviceCursor(options, signal);
  const [row] = await readCommittedEventsAfter(db, "authority.event", { after: { id: previous.event_id, commit_txid: previous.commit_txid }, limit: 1 });
  if (!row) return false;
  const delivery = await deliveryFor(db, { row, namespace: options.namespace, previous });
  const response = await (options.fetcher ?? fetch)(new URL("/v1/sources/oakridge/events", options.url), {
    method: "POST", headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
    body: JSON.stringify(delivery), signal,
  });
  if (!response.ok) throw new Error(`observation delivery HTTP ${response.status}`);
  const ack = await response.json() as DeliveryAck;
  if (ack.cursor?.commit_txid !== delivery.cursor.commit_txid || ack.cursor.event_id !== delivery.cursor.event_id)
    throw new Error("observation acknowledged a different cursor");
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
        if (!await publishObservationOnce(db, options, controller.signal)) await wait();
      }
      catch (cause) {
        if (!controller.signal.aborted) { log(`observation publisher: ${cause instanceof Error ? cause.message : String(cause)}`); await wait(); }
      }
    }
  })();
  return { async stop() { controller.abort(); await running; } };
}

export interface ObservationCost { run_id: string; charged_usd: number }
export async function readObservationCost(options: ObservationOptions | null | undefined, run_id: string): Promise<import("../domain/primitives").Traced<ObservationCost | null>> {
  if (!options?.read_token) return { ok: true, value: null };
  try {
    const response = await (options.fetcher ?? fetch)(new URL(`/v1/runs/${encodeURIComponent(run_id)}/cost`, options.url),
      { headers: { authorization: `Bearer ${options.read_token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json() as ObservationCost;
    if (value.run_id !== run_id || !Number.isFinite(value.charged_usd)) throw new Error("invalid cost response");
    return { ok: true, value };
  } catch (cause) { return { ok: false, error: { operation: "observation.cost", entity_id: run_id, detail: String(cause) } }; }
}
