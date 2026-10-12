import { expect, test } from "bun:test";
import type { RunId } from "../src/domain/primitives";
import { selectReportEvent, type ExecutorReport } from "../src/workflows/executor-ingress";

const published = (predecessor: string | null): ExecutorReport => ({ run_id: "run-1" as RunId, attempt: { action_id: "u:poll:Initial:Periodic", seq: 2 },
  report: { kind: "published", unit: "u", artifact: "pr_state", body: { open: true }, predecessor } });

test("code worker output carries the predecessor the executor resolved, so a changed value follows the latest revision", () => {
  const { event } = selectReportEvent(published("u:pr_state:1"));
  expect(event.kind === "revision_published" ? { predecessor: event.predecessor, by: event.by } : null)
    .toEqual({ predecessor: "u:pr_state:1", by: "u:poll:Initial:Periodic" });
});

test("a re-sent publication report is the same event under the same ingress id", () => {
  expect(selectReportEvent(published("u:pr_state:1"))).toEqual(selectReportEvent(published("u:pr_state:1")));
});
