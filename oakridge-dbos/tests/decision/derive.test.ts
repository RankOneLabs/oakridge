import { expect, test } from "bun:test";

import { derive } from "../../src/decision/derive";
import type { RunRecordVersion } from "../../src/domain/primitives";
import { artifactId, cohort, RUN_ID, snapshot, stage, stageId } from "./snapshot-builder";
import type { CoreStatus } from "../../src/domain/records";

test("a source stage starts against its own durable version", () => {
  const source = stage(1, { durable_version: 7 });
  expect(derive(snapshot([source]))).toEqual({ ok: true, value: {
    observed_artifact_ids: [],
    commands: [{
      kind: "transition_stage",
      run_id: RUN_ID,
      stage_instance_id: source.id,
      expected_version: 7,
      change: { status: "active", blocked_reason: null, next_actor: "core", outcome: null },
      effect: { kind: "start_stage", stage_instance_id: source.id },
    }],
  } });
});

test("a dependent stage reads committed stage status rather than artifact bodies", () => {
  const upstream = stage(1, { status: "complete", accepted_artifact_ids: [artifactId(3)] });
  const downstream = stage(2, { dependencies: [upstream.id] });
  const result = derive(snapshot([downstream, upstream]));
  expect(result.ok && result.value.commands.map((command) => command.kind)).toEqual(["transition_stage"]);
  expect(result.ok && result.value.observed_artifact_ids).toEqual([artifactId(3)]);
});

test("an incomplete dependency leaves a pending stage alone", () => {
  const upstream = stage(1, { status: "active" });
  const downstream = stage(2, { dependencies: [upstream.id] });
  expect(derive(snapshot([upstream, downstream]))).toEqual({ ok: true, value: { commands: [], observed_artifact_ids: [] } });
});

test("all complete cohorts complete their stage on the stage version", () => {
  const value = stage(1, { status: "active", durable_version: 4, cohorts: [
    cohort(1, { status: "complete" }),
    cohort(2, { status: "complete" }),
  ] });
  const result = derive(snapshot([value], { record_version: 19 }));
  expect(result.ok && result.value.commands[0]).toEqual({
    kind: "transition_stage",
    run_id: RUN_ID,
    stage_instance_id: value.id,
    expected_version: 4,
    change: { status: "complete", blocked_reason: null, next_actor: null, outcome: { kind: "succeeded" } },
    effect: { kind: "none" },
  });
});

test("a cancelled cohort deterministically cancels its active stage", () => {
  const value = stage(1, { status: "active", durable_version: 6, cohorts: [
    cohort(2, { status: "failed", outcome: { reason: "failed" } }),
    cohort(1, { status: "cancelled", outcome: { reason: "operator" } }),
  ] });
  const result = derive(snapshot([value]));
  expect(result.ok && result.value.commands).toEqual([{
    kind: "transition_stage",
    run_id: RUN_ID,
    stage_instance_id: value.id,
    expected_version: 6,
    change: { status: "cancelled", blocked_reason: null, next_actor: null, outcome: { reason: "operator" } },
    effect: { kind: "none" },
  }]);
});

test("a failed cohort fails its active stage", () => {
  const value = stage(1, { status: "active", durable_version: 3, cohorts: [cohort(1, { status: "failed" })] });
  const result = derive(snapshot([value]));
  expect(result.ok && result.value.commands[0]).toMatchObject({
    kind: "transition_stage",
    expected_version: 3,
    change: { status: "failed", outcome: { kind: "failed", cohort_id: value.cohorts[0]?.id } },
  });
});

test("completed stages complete the run against the run record version", () => {
  const result = derive(snapshot([stage(1, { status: "complete" }), stage(2, { status: "complete" })], { record_version: 12 }));
  expect(result.ok && result.value.commands[0]).toEqual({
    kind: "transition_run",
    run_id: RUN_ID,
    expected_version: 12 as RunRecordVersion,
    change: { status: "complete", blocked_reason: null, next_actor: null, outcome: { kind: "succeeded" } },
    effect: { kind: "none" },
  });
});

test("a cancelled stage deterministically wins over a failed stage", () => {
  const result = derive(snapshot([
    stage(1, { status: "failed", outcome: { code: "failed" } }),
    stage(2, { status: "cancelled", outcome: { reason: "operator" } }),
  ], { record_version: 9 }));
  expect(result.ok && result.value.commands[0]).toMatchObject({
    kind: "transition_run",
    expected_version: 9,
    change: { status: "cancelled", outcome: { reason: "operator" } },
  });
});

test("accepted artifact identities are total, unique, and sorted", () => {
  const result = derive(snapshot([
    stage(2, { status: "active", accepted_artifact_ids: [artifactId(4)], cohorts: [cohort(2, { accepted_artifact_ids: [artifactId(2)] })] }),
    stage(1, { status: "active", accepted_artifact_ids: [artifactId(2), artifactId(1)] }),
  ]));
  expect(result.ok && result.value.observed_artifact_ids).toEqual([artifactId(1), artifactId(2), artifactId(4)]);
});

test("an unknown stage dependency is a contradiction", () => {
  const dependent = stage(1, { dependencies: [stageId(99)] });
  expect(derive(snapshot([dependent]))).toEqual({ ok: false, error: {
    kind: "unknown_stage_dependency",
    stage_instance_id: dependent.id,
    dependency_stage_instance_id: stageId(99),
  } });
});

test("derive is stable across repeated calls and snapshot order", () => {
  const values = [stage(2), stage(1)];
  const first = derive(snapshot(values));
  expect(derive(snapshot(values))).toEqual(first);
  expect(derive(snapshot([...values].reverse()))).toEqual(first);
});

test("a terminal run never emits another transition", () => {
  expect(derive(snapshot([stage(1)], { status: "complete" }))).toEqual({
    ok: true,
    value: { commands: [], observed_artifact_ids: [] },
  });
});

test("all six statuses across the six-stage graph follow the table-free run oracle", () => {
  const statuses: readonly CoreStatus[] = ["pending", "active", "blocked", "complete", "failed", "cancelled"];
  const dependencies = [[], [0], [0], [1, 2], [3], [4]] as const;
  for (let combination = 0; combination < statuses.length ** 6; combination++) {
    let remaining = combination;
    const selected = dependencies.map(() => {
      const status = statuses[remaining % statuses.length]!;
      remaining = Math.floor(remaining / statuses.length);
      return status;
    });
    const stages = selected.map((status, index) => stage(index + 1, {
      status,
      dependencies: dependencies[index]!.map((dependency) => stageId(dependency + 1)),
    }));
    const result = derive(snapshot(stages));
    if (!result.ok) throw new Error(`unexpected contradiction at combination ${combination}`);
    const actual = result.value.commands.map((command) => ({
      kind: command.kind,
      target: command.kind === "transition_stage" ? command.stage_instance_id : RUN_ID,
      status: command.change.status,
    }));
    const cancelled = selected.indexOf("cancelled");
    const failed = selected.indexOf("failed");
    const expected: typeof actual = cancelled >= 0 ? [{ kind: "transition_run", target: RUN_ID, status: "cancelled" }]
      : failed >= 0 ? [{ kind: "transition_run", target: RUN_ID, status: "failed" }]
        : selected.every((status) => status === "complete") ? [{ kind: "transition_run", target: RUN_ID, status: "complete" }]
          : selected.flatMap((status, index) => status === "pending"
            && dependencies[index]!.every((dependency) => selected[dependency] === "complete")
            ? [{ kind: "transition_stage", target: stageId(index + 1), status: "active" }] : []);
    expect(actual).toEqual(expected);
  }
});

test("blocked stages do not complete from completed cohorts while active stages do", () => {
  const completed = cohort(1, { status: "complete" });
  const activeResult = derive(snapshot([stage(1, { status: "active", cohorts: [completed] })]));
  const blockedResult = derive(snapshot([stage(1, { status: "blocked", cohorts: [completed] })]));
  expect(activeResult.ok && activeResult.value.commands[0]?.kind).toBe("transition_stage");
  expect(blockedResult.ok && blockedResult.value.commands).toEqual([]);
});
