import { expect, test } from "bun:test";
import type { RunId } from "../src/domain/primitives";
import { selectOperatorFrame } from "../src/projections/operator-event";

test("a commit fault streams as an invalidation of its run", () => {
  const frame = selectOperatorFrame({ id: "row-1", commit_txid: "1", payload: { kind: "commit_fault", data: { run_id: "run" as RunId, unit_id: null,
    at_unit: null, ingress_id: null, event: { kind: "cancel_requested" }, detail: "checked stage absent", after_event: null } } });
  expect(frame).toEqual({ event: "invalidate", data: { kind: "invalidate", target: "run", run_id: "run" as RunId } });
});
