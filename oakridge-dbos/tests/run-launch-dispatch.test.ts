import { expect, test } from "bun:test";

import type { RootWorkflowId, WorkflowRunId } from "../src/domain/primitives";
import type { UnstartedRun } from "../src/domain/runs";
import { dispatchRunLaunches, type RunLaunchDbosClient, type RunStartRequest } from "../src/runtime/run-launch-dispatch";
import type { WorkflowRunRepository } from "../src/storage/repositories";

const unstartedRun = (n: number): UnstartedRun => ({ run_id: `run-${n}` as WorkflowRunId, workflow_id: `v2-run:run-${n}` as RootWorkflowId });

/** Paged `list_unstarted_runs`: each call consumes the next page, `[]` once exhausted. */
const fakeRuns = (pages: readonly (readonly UnstartedRun[])[]): { readonly repository: Pick<WorkflowRunRepository, "list_unstarted_runs">; readonly limits: number[] } => {
  const limits: number[] = [];
  let call = 0;
  return {
    limits,
    repository: {
      async list_unstarted_runs(limit: number) {
        limits.push(limit);
        const page = pages[call] ?? [];
        call += 1;
        return page;
      },
    },
  };
};

const fakeDbos = (shouldFail: (run: UnstartedRun) => boolean = () => false): { readonly client: RunLaunchDbosClient; readonly calls: RunStartRequest[] } => {
  const calls: RunStartRequest[] = [];
  return {
    calls,
    client: {
      async start_v2_run(request) {
        calls.push(request);
        if (shouldFail({ run_id: request.run_id, workflow_id: request.workflow_id })) {
          return { ok: false, error: { operation: "start_v2_run", workflow_id: request.workflow_id, run_id: request.run_id, detail: "DBOS unreachable" } };
        }
        return { ok: true, value: undefined };
      },
    },
  };
};

test("the sweep starts every unstarted run and counts successes", async () => {
  const runs = [unstartedRun(1), unstartedRun(2), unstartedRun(3)];
  const { repository, limits } = fakeRuns([runs, []]);
  const { client, calls } = fakeDbos();
  const started = await dispatchRunLaunches(repository, client, "app-v1");
  expect(started).toBe(3);
  expect(calls.map((call) => `${call.workflow_id}:${call.run_id}:${call.application_version}`)).toEqual(
    runs.map((run) => `${run.workflow_id}:${run.run_id}:app-v1`));
  // A short first page ends the sweep without a follow-up fetch.
  expect(limits).toEqual([100]);
});

test("the sweep keeps going past a failure, counting only the successes", async () => {
  const runs = [unstartedRun(1), unstartedRun(2), unstartedRun(3)];
  const { repository } = fakeRuns([runs, []]);
  const { client, calls } = fakeDbos((run) => run.run_id === "run-2");
  const started = await dispatchRunLaunches(repository, client, null);
  expect(started).toBe(2);
  // The failing run did not stop the sweep from reaching the one after it.
  expect(calls.map((call) => call.run_id)).toEqual(runs.map((run) => run.run_id));
});

test("a full page of exactly the limit is followed by another fetch; a short page ends the sweep", async () => {
  const fullPage = Array.from({ length: 100 }, (_unused, index) => unstartedRun(index));
  const shortPage = [unstartedRun(1000)];
  const { repository, limits } = fakeRuns([fullPage, shortPage]);
  const { client, calls } = fakeDbos();
  const started = await dispatchRunLaunches(repository, client, null);
  expect(started).toBe(101);
  expect(calls).toHaveLength(101);
  expect(limits).toEqual([100, 100]);
});

test("an application version is omitted from the start request when unset", async () => {
  const { repository } = fakeRuns([[unstartedRun(1)], []]);
  const { client, calls } = fakeDbos();
  await dispatchRunLaunches(repository, client, null);
  expect(calls[0]).not.toHaveProperty("application_version");
});

/**
 * A failed run is still "unstarted", so a follow-up fetch would hand it
 * straight back; with a hundred persistently failing runs the loop would
 * never return. The sweep ends at the first page that saw a failure — the
 * next timer tick is the retry, as the old outbox's `next_attempt_at` was.
 */
test("a full page containing a failure ends the sweep instead of fetching the next page", async () => {
  const fullPage = Array.from({ length: 100 }, (_unused, index) => unstartedRun(index));
  const { repository, limits } = fakeRuns([fullPage, fullPage]);
  const { client, calls } = fakeDbos((run) => run.run_id === "run-7");
  const started = await dispatchRunLaunches(repository, client, null);
  expect(started).toBe(99);
  expect(calls).toHaveLength(100);
  expect(limits).toEqual([100]);
});
