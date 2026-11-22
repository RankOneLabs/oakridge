import type { DeliveryCursor } from "./dbos-revision-delivery";
export type { DeliveryAck as SourceEventAck, DeliveryCursor as SourceEventCursor, DeliveryRunConfig as RunConfigWire } from "./dbos-revision-delivery";

export const INITIAL_SOURCE_CURSOR: DeliveryCursor = { commit_txid: "0", event_id: "" };

export function isDeliveryCursor(value: unknown): value is DeliveryCursor {
  return typeof value === "object" && value !== null && "commit_txid" in value && "event_id" in value
    && typeof value.commit_txid === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value.commit_txid)
    && BigInt(value.commit_txid) <= 9223372036854775807n && typeof value.event_id === "string";
}
