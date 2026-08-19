/**
 * Containment withdraws a gate or handoff wait by sending it a command and
 * awaiting the workflow's acknowledgement. That only works if something will
 * resume the workflow to read the message — and DBOS resumes a workflow only at
 * a matching application version. A wait stranded by a version bump never
 * answers, so awaiting it blocked cancellation forever: the documented way out
 * of a stuck run hung on precisely the runs that were stuck.
 */
import { expect, test } from "bun:test";

import { selectCancellationWaitSplit, type CancellationWaitTarget } from "../src/domain/rerun";

const gate = (workflow_id: string, application_version: string | null): CancellationWaitTarget =>
  ({ kind: "gate", workflow_id, application_version });
const handoff = (workflow_id: string, application_version: string | null): CancellationWaitTarget =>
  ({ kind: "handoff", workflow_id, application_version });

test("a wait this executor can recover is withdrawn cooperatively", () => {
  const split = selectCancellationWaitSplit([gate("gate-1", "v2")], "v2");
  expect(split.answerable).toEqual([gate("gate-1", "v2")]);
  expect(split.orphaned).toEqual([]);
});

test("a wait stranded at another version is not waited on", () => {
  const split = selectCancellationWaitSplit([handoff("handoff-1", "v1")], "v2");
  expect(split.answerable).toEqual([]);
  expect(split.orphaned).toEqual([{ wait: handoff("handoff-1", "v1"), holder_application_version: "v1" }]);
});

/**
 * The mixed case is the real one: a run orphaned mid-flight has waits from the
 * bump alongside waits this executor started afterwards. Sorting the orphan out
 * must not cost the live wait its cooperative withdrawal.
 */
test("a live wait is still withdrawn when an orphaned one sits beside it", () => {
  const split = selectCancellationWaitSplit([gate("gate-1", "v1"), handoff("handoff-1", "v2")], "v2");
  expect(split.answerable).toEqual([handoff("handoff-1", "v2")]);
  expect(split.orphaned.map((entry) => entry.wait.workflow_id)).toEqual(["gate-1"]);
});

/**
 * A wait with no recorded version predates version-tagged workflows. Treating
 * it as orphaned would cancel a wait that might still answer, which is the
 * costlier mistake of the two.
 */
test("a wait with no recorded version is treated as answerable", () => {
  expect(selectCancellationWaitSplit([gate("gate-1", null)], "v2").answerable).toEqual([gate("gate-1", null)]);
});

test("nothing to contain splits into nothing", () => {
  expect(selectCancellationWaitSplit([], "v2")).toEqual({ answerable: [], orphaned: [] });
});
