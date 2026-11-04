import { expect, test } from "bun:test";
import type { CaptureEnvelope as ServiceCaptureEnvelope } from "../../observation/src/ingest/capture";
import type { SourceEventAck as ServiceAck, SourceEventCursor as ServiceCursor,
  SourceEventDelivery as ServiceDelivery, SourceEventOutcome as ServiceOutcome } from "../../observation/src/ingest/cursor";
import type { CaptureEnvelope, SourceEventAck, SourceEventCursor, SourceEventDelivery, SourceEventOutcome } from "../src/adapters/observation-wire";

type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;
type WireContract = [Assert<Equal<CaptureEnvelope, ServiceCaptureEnvelope>>,
  Assert<Equal<SourceEventCursor, ServiceCursor>>, Assert<SourceEventOutcome extends ServiceOutcome ? true : false>,
  Assert<SourceEventDelivery extends ServiceDelivery ? true : false>, Assert<Equal<SourceEventAck, ServiceAck>>];

test("Oakridge producer wire types are accepted by the observation service contract", () => {
  const checked: WireContract = [true, true, true, true, true];
  expect(checked.every(Boolean)).toBe(true);
});
