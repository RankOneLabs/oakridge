// Compare the frozen traces across W2's intentional StepResult wire change.
// Build workflow-evaluator for wasm32-unknown-unknown in both checkouts, then run:
//   bun scripts/replay-core-w2.mjs /path/to/pre-W2-checkout
// The current checkout must be the working directory. The baseline checkout
// should be W0 (752192e7) and must contain its built evaluator WASM.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPERATION_REGISTRY } from "../oakridge-dbos/src/operations/registry.ts";

const current = process.cwd();
const baselineArg = process.argv[2];
if (!baselineArg) {
  throw new Error("Usage: bun scripts/replay-core-w2.mjs /path/to/pre-W2-checkout");
}
const baseline = resolve(baselineArg);

function evaluator(root) {
  const bytes = readFileSync(`${root}/workflow-core/target/wasm32-unknown-unknown/debug/workflow_evaluator.wasm`);
  const module = new WebAssembly.Module(bytes);
  const core = new WebAssembly.Instance(module, {}).exports;
  let requestId = 0;

  return (operation, input) => {
    const request = new TextEncoder().encode(JSON.stringify({
      version: 4,
      request_id: String(++requestId),
      operation,
      input,
    }));
    const pointer = core.core_alloc(request.length);
    try {
      new Uint8Array(core.memory.buffer, pointer, request.length).set(request);
      const responsePointer = core.core_process(pointer, request.length);
      const responseBytes = new Uint8Array(core.memory.buffer, responsePointer, core.core_response_len()).slice();
      const response = JSON.parse(new TextDecoder().decode(responseBytes));
      if (response.result.status !== "ok") throw new Error(JSON.stringify(response.result));
      return response.result.value.value;
    } finally {
      core.core_dealloc(pointer, request.length);
    }
  };
}

const promptPaths = [
  "review-loop/write.md",
  "review-loop/revise.md",
  "review-loop/critique.md",
  "review-loop/editor.md",
  "fan-out/item.md",
];
const prompts = Object.fromEntries(promptPaths.map((path) => [
  path,
  readFileSync(`${current}/workflow-config/prompts/${path}`, "utf8"),
]));

const initialSnapshot = () => ({
  run: { id: "run", root: "run", status: { kind: "not_started" }, input: null },
  units: [],
  attempts: [],
  revisions: [],
  decisions: [],
  retry_events: [],
});

function actionId(snapshot, spec) {
  return snapshot.attempts.findLast((attempt) =>
    attempt.unit === spec.unit && attempt.worker === spec.worker)?.action_id;
}

function event(snapshot, spec) {
  const id = actionId(snapshot, spec);
  switch (spec.op) {
    case "launch": return { kind: "launched", input: spec.input };
    case "started": return {
      kind: "worker_started",
      action: id,
      kbbl_session_id: `session:${spec.unit}:${spec.worker}`,
    };
    case "ended": return {
      kind: "worker_ended",
      action: id,
      result: spec.result === "succeeded"
        ? { kind: "succeeded" }
        : { kind: "failed", code: "failed", detail: "test failure" },
    };
    case "publish": return {
      kind: "revision_published",
      unit: spec.unit,
      artifact: spec.artifact,
      body: spec.body,
      predecessor: spec.predecessor ?? null,
      subject: spec.subject ?? null,
      by: id,
    };
    case "decide": return {
      kind: "operator_decided",
      unit: spec.unit,
      review: spec.review,
      decision: spec.decision,
      target: spec.target,
      payload: spec.payload,
    };
    case "retry": return { kind: "retry_requested", unit: spec.unit, worker: spec.worker };
    default: throw new Error(`unknown event ${spec.op}`);
  }
}

// W2 projection paths:
// before: StepResult.wanted[*][0] is unit, StepResult.wanted[*][1][*] is action,
//         and StepResult.resolved[*] is the resolved worker input.
// after:  StepResult.wanted[*].{unit,action,resolved}; action_id, attempt_seq,
//         and worker are excluded from the wanted-set comparison.
// Snapshot and reviews are compared unchanged; resolved inputs are compared
// unchanged after moving them under each wanted entry.
function projectBeforeW2(step) {
  return {
    snapshot: step.snapshot,
    reviews: step.reviews,
    wanted: step.wanted.flatMap(([unit, actions]) =>
      actions.map((action) => ({ unit, action }))),
    resolved: step.resolved,
  };
}

function projectAfterW2(step) {
  return {
    snapshot: step.snapshot,
    reviews: step.reviews,
    wanted: step.wanted.map(({ unit, action }) => ({ unit, action })),
    resolved: step.wanted.map(({ resolved }) => resolved),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function assertEqual(before, after, location) {
  if (JSON.stringify(canonical(before)) !== JSON.stringify(canonical(after))) {
    throw new Error(`${location}: W2 projection differs`);
  }
}

const beforeCore = evaluator(baseline);
const afterCore = evaluator(current);
let comparisons = 0;

for (const traceName of ["review-loop", "fan-out", "fan-out-stall"]) {
  const trace = JSON.parse(readFileSync(`${current}/workflow-core/fixtures/traces/${traceName}.json`, "utf8"));
  const workflow = JSON.parse(readFileSync(`${current}/workflow-core/fixtures/bundles/${trace.sample}.json`, "utf8"));
  const input = { workflow, operations: OPERATION_REGISTRY, prompts };
  const beforeDigest = beforeCore("compile", input).digest;
  const afterDigest = afterCore("compile", input).digest;
  if (beforeDigest !== afterDigest) throw new Error(`${traceName}: bundle digests differ`);

  let beforeSnapshot = initialSnapshot();
  let afterSnapshot = initialSnapshot();
  for (const [rowIndex, row] of trace.rows.entries()) {
    for (const [index, spec] of row.events.entries()) {
      const ingress_id = `${rowIndex}:${index}`;
      const beforeStep = beforeCore("step", {
        workflow_digest: beforeDigest,
        snapshot: beforeSnapshot,
        incoming: { event: event(beforeSnapshot, spec), writer: { kind: "engine" }, ingress_id },
      });
      const afterStep = afterCore("step", {
        workflow_digest: afterDigest,
        snapshot: afterSnapshot,
        incoming: { event: event(afterSnapshot, spec), writer: { kind: "engine" }, ingress_id },
      });
      assertEqual(projectBeforeW2(beforeStep), projectAfterW2(afterStep),
        `${traceName} row ${rowIndex} event ${index}`);
      beforeSnapshot = beforeStep.snapshot;
      afterSnapshot = afterStep.snapshot;
      comparisons++;
    }
  }
}

console.log(`W2 projection matched ${comparisons} step responses across 3 frozen traces; snapshots, reviews, and resolved inputs matched exactly.`);
