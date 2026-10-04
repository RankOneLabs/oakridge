import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ok, type JsonValue } from "../src/domain/primitives";
import { AdapterRegistry } from "../src/runtime/executor-registry";
import { transitionEffectWorkflowId } from "../src/decision/ids";
import { loadGraphDefinitionFixture as loadDevFlowV15 } from "./support/graph-definition-fixture";

const SOURCE = new URL("../src", import.meta.url).pathname;
const FORBIDDEN_IDENTIFIERS = [
  "unit_id_path",
  "depends_on_path",
  "id_path",
  "readJsonPointer",
  "pull_request_observed",
  "pull_request_merge_confirmed",
] as const;
const DEV_FLOW_ROLES = ["spec", "plan", "brief", "build", "assessment", "final_integration"] as const;
// Each exception owns an adapter-facing contract or composition point.
const DEV_FLOW_SOURCE_ALLOWLIST = {
  "runtime/prepare-cohort-repository.ts": "Prepares canonical implementation and final repository worktrees.",
  "runtime/observe-cohort-pull-request.ts": "Reads and verifies canonical cohort PR observations.",
  "domain/v15-operator-review.ts": "Projects exact canonical worker targets for operator decisions.",
  "runtime/final-integration.ts": "Verifies and discovers final PRs against frozen repository authority.",
  "validation/v15-definition.ts": "Validates the concrete dev-flow worker, output, input and decision-tree contracts.",
  "adapters/dev-flow-machine.ts": "Exports legacy names used only to validate graph fixtures during cutover.",
  "adapters/dev-flow.ts": "Implements dev-flow effects and registration.",
  "compiler/resolve-execution.ts": "Carries an optional existing handoff URL into a delegated prompt.",
  "domain/artifact-types.ts": "Registers the existing assessment artifact presentation.",
  "domain/cohort-pull-request.ts": "Defines dev-flow cohort handoff facts.",
  "domain/delegated-session.ts": "Carries an optional existing handoff URL in session context.",
  "domain/dev-flow-artifacts.ts": "Defines assessment artifact validation.",
  "domain/dev-flow-v15.ts": "Owns the checked v15 unions and future evaluator; typed contract names belong here, outside core decision and records.",
  "domain/epic.ts": "Defines the dev-flow epic contract.",
  "domain/gates.ts": "Maps the assessment artifact disposition.",
  "domain/operator-projections.ts": "Keeps existing operator review item and diagnosis contracts.",
  "domain/pull-request.ts": "Defines forge pull-request facts.",
  "domain/repository-refs.ts": "Defines dev-flow branch roles.",
  "http/app.ts": "Mounts the registered dev-flow refresh route.",
  "http/cohort-pull-request.ts": "Exposes the dev-flow refresh route.",
  "main.ts": "Wires the forge poller at process startup.",
  "runtime/cohort-pull-request.ts": "Reconciles the dev-flow handoff.",
  "runtime/implementation-worker-session.ts": "Resolves pinned implementation action inputs at the kbbl session boundary.",
  "runtime/implementation-publication.ts": "Reads forge and origin evidence for implementation publication without writing bindings.",
  "runtime/compose.ts": "Wires dev-flow services and the contributor at composition.",
  "runtime/github-pull-requests.ts": "Polls forge pull requests for the adapter.",
  "runtime/resolve-work-order.ts": "Passes existing handoff context to the agent.",
  "storage/migrate.ts": "Recognizes the retired dev-flow migration ledger name.",
  "storage/postgres-dev-flow.ts": "Owns dev-flow persistence and projection details.",
  "storage/postgres-operators.ts": "Keeps existing operator merge-wait and inbox contracts.",
  "storage/repositories.ts": "Declares the dev-flow repository port used by its adapter.",
} as const;
const DEV_FLOW_IDENTIFIER = /dev_flow_build_cohort|pull_request|canonical_ref|dev\.assessment/;
const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const coreBoundaryViolations = (source: string): readonly string[] => {
  const identifiers = FORBIDDEN_IDENTIFIERS.filter((identifier) => source.includes(identifier));
  const roles = DEV_FLOW_ROLES.filter((role) => source.includes(`"${role}"`) || source.includes(`'${role}'`));
  const sentinel = /unit_id[^\n]*(?:"0"|'0')/.test(source) ? ["unit_id zero sentinel"] : [];
  return [...identifiers, ...roles, ...sentinel];
};

const decisionSources = async (): Promise<readonly string[]> => {
  const directory = join(SOURCE, "decision");
  return (await readdir(directory)).filter((name) => name.endsWith(".ts")).map((name) => join(directory, name));
};

const treeSources = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? treeSources(join(directory, entry.name))
    : Promise.resolve(entry.name.endsWith(".ts") ? [join(directory, entry.name)] : [])));
  return nested.flat();
};

test("dev-flow identifiers stay in the documented adapter allowlist", async () => {
  const files = await treeSources(SOURCE);
  const offenders = (await Promise.all(files.map(async (file) => ({
    file: file.slice(SOURCE.length + 1), source: await readFile(file, "utf8"),
  })))).filter(({ file, source }) => DEV_FLOW_IDENTIFIER.test(source)
    && !(file in DEV_FLOW_SOURCE_ALLOWLIST)).map(({ file }) => file).sort();
  expect(offenders).toEqual([]);
});

// The v15 typed contract names integration_branch. This assertion guards core
// reach-through into adapter data while permitting that name in its declared home.
test("core records and persistence have no adapter integration branch reach-through", async () => {
  const files = [...await decisionSources(), join(SOURCE, "domain", "records.ts"),
    ...(await readdir(join(SOURCE, "storage"))).filter((name) => name.startsWith("postgres-run-record") && name.endsWith(".ts"))
      .map((name) => join(SOURCE, "storage", name))];
  const offenders = (await Promise.all(files.map(async (file) => ({ file, source: await readFile(file, "utf8") }))))
    .filter(({ source }) => source.includes("integration_branch")).map(({ file }) => file.slice(SOURCE.length + 1));
  expect(offenders).toEqual([]);
  expect(await readFile(join(SOURCE, "domain", "records.ts"), "utf8"))
    .not.toMatch(/readonly\s+integration_branch\s*:/);
});

test("core operator projections never query adapter tables", async () => {
  const source = await readFile(join(SOURCE, "storage", "postgres-operators.ts"), "utf8");
  expect(source).not.toMatch(/(?:FROM|JOIN|UPDATE|INTO)\s+dev_flow\./i);
});

// The v15 evaluator and launch identity now own checked worker names. The
// generic run derivation and records remain independent of those roles.
test("generic run derivation and records do not interpret dev-flow identifiers", async () => {
  const files = [join(SOURCE, "decision", "derive.ts"), join(SOURCE, "decision", "commands.ts"),
    join(SOURCE, "decision", "snapshot.ts"), join(SOURCE, "domain", "records.ts")];
  const violations = (await Promise.all(files.map(async (file) => ({ file, violations: coreBoundaryViolations(await readFile(file, "utf8")) }))))
    .filter((entry) => entry.violations.length > 0);
  expect(violations).toEqual([]);
});

test("the architecture rule rejects a dev-flow role introduced into core", () => {
  expect(coreBoundaryViolations('const operator_role = "build";')).toContain("build");
});

test("a newly registered adapter event decodes, guards, and selects its effect without a core edit", () => {
  const registry = new AdapterRegistry();
  const eventName = "example_adapter_finished";
  registry.register_decision<{ readonly output_id: string }>({
    name: eventName,
    decode(value: JsonValue) {
      if (isJsonObject(value) && typeof value.output_id === "string") {
        return ok({ output_id: value.output_id });
      }
      return { ok: false, error: "output_id is required" };
    },
    guard: () => ok(undefined),
    effect: (context, payload) => ({ kind: context.event_name, output_id: payload.output_id }),
  });
  expect(registry.dispatch(eventName, { output_id: "artifact-1" }, "adapter")).toEqual({ ok: true, value: {
    payload: { output_id: "artifact-1" },
    effect: { kind: eventName, output_id: "artifact-1" },
  } });
});

test("source contains no second pending-effect store", async () => {
  const files = await decisionSources();
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  expect(source).not.toMatch(/pending[_ -]?effects?|command[_ -]?outbox/i);
});

test("the baseline stores arbitrary registered effects without event-name checks", async () => {
  const baseline = await readFile(join(SOURCE, "storage", "migrations", "0015_v15_baseline.sql"), "utf8");
  expect(baseline).not.toContain("pull_request_observed");
  expect(baseline).not.toContain("pull_request_merge_confirmed");
  expect(baseline).toContain("effect_descriptor jsonb NOT NULL");
  expect(baseline).toContain("effect_workflow_id text NOT NULL UNIQUE");
});

test("adapter launch reason names require no core decision or migration edit", async () => {
  const decision = (await Promise.all((await decisionSources()).map((file) => readFile(file, "utf8")))).join("\n");
  const baseline = await readFile(join(SOURCE, "storage", "migrations", "0015_v15_baseline.sql"), "utf8");
  const loaded = await loadDevFlowV15();
  if (!loaded.ok) throw new Error(loaded.error.detail);
  const reasons = new Set(Object.values(loaded.value.machines ?? {}).flatMap((machine) => machine.transitions
    .flatMap((row) => "effects" in row ? row.effects : [])
    .filter((effect) => effect.name === "launch_session")
    .map((effect) => effect.args.reason)
    .filter((reason): reason is string => typeof reason === "string")));
  for (const reason of reasons) {
    if (reason === "initial" || reason === "operator_retry") continue;
    expect(decision).not.toContain(`"${reason}"`);
    expect(baseline).not.toContain(`'${reason}'`);
  }
});

test("operator and downstream roles are not closed over dev-flow names", async () => {
  const sources = await Promise.all([
    join(SOURCE, "domain", "workflow.ts"),
    join(SOURCE, "validation", "workflow-definition.ts"),
    join(SOURCE, "validation", "delegated-session.ts"),
  ].map((file) => readFile(file, "utf8")));
  const combined = sources.join("\n");
  expect(combined).not.toMatch(/StageOperatorRole\s*=\s*["'](?:spec|plan|brief|build|assessment|final_integration)/);
  expect(combined).not.toMatch(/z\.enum\(\[[^\]]*["'](?:spec|plan|brief|build|assessment|final_integration)["']/s);
});

test("core never reads final integration branch or merge policy", async () => {
  const files = [...await decisionSources(), join(SOURCE, "domain", "records.ts")];
  const core = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  expect(core).not.toContain(".integration_branch");
  expect(core).not.toContain(".final_merge_policy");
  const adapter = await readFile(join(SOURCE, "domain", "repository-refs.ts"), "utf8");
  expect(adapter).toContain("integration_branch");
});

/**
 * Keyed on the *lifecycle tables* rather than on the parameter's cast.
 *
 * The five owners below are the ones whose status moves with a durable version,
 * and one module writes all of them — that is the invariant. Keying on
 * `::oakridge.X_status` instead let a literal `SET status='cancelled'` on a
 * cohort, attempt or session past the guard, which is exactly the write the rule
 * exists to catch. Keying on the bare `SET status=` was the other failure: it
 * flagged a closed wait and a resolved artifact thread, neither of which is a
 * lifecycle owner.
 */
const LIFECYCLE_TABLES = ["workflow_run", "stage_instance", "cohort", "attempt", "session"];
const LIFECYCLE_STATUS_WRITE = new RegExp(
  `(?:UPDATE|INSERT\\s+INTO)\\s+oakridge\\.(?:${LIFECYCLE_TABLES.join("|")})\\b[^;\`]*?\\bSET\\b[^;\`]*?\\bstatus\\s*=`,
  "is");

test("lifecycle status SQL has one writer", async () => {
  const files = await treeSources(SOURCE);
  const writers = (await Promise.all(files.map(async (file) => ({ file, source: await readFile(file, "utf8") }))))
    .filter((entry) => LIFECYCLE_STATUS_WRITE.test(entry.source))
    .map((entry) => entry.file.slice(SOURCE.length + 1));
  expect(writers).toEqual(["storage/postgres-run-record.ts"]);
});

test("the lifecycle rule ignores a wait close and an artifact thread resolution", () => {
  expect(LIFECYCLE_STATUS_WRITE.test("UPDATE oakridge.wait_gate SET status='closed' WHERE id=$1")).toBe(false);
  expect(LIFECYCLE_STATUS_WRITE.test("UPDATE oakridge.artifact_thread SET status=$2 WHERE id=$1")).toBe(false);
  expect(LIFECYCLE_STATUS_WRITE.test("UPDATE oakridge.stage_instance\n     SET status=$3::oakridge.core_status")).toBe(true);
});

test("the lifecycle rule catches a literal status write to a cohort", () => {
  expect(LIFECYCLE_STATUS_WRITE.test("UPDATE oakridge.cohort SET status='cancelled' WHERE id=$1")).toBe(true);
  expect(LIFECYCLE_STATUS_WRITE.test("UPDATE oakridge.attempt attempt SET ended_at=now(),status='failed'")).toBe(true);
  expect(LIFECYCLE_STATUS_WRITE.test("UPDATE oakridge.session SET adapter_reference=$2::jsonb WHERE id=$1")).toBe(false);
});

test("each cohort transition has one stable effect workflow address", () => {
  const first = "00000000-0000-4000-8000-000000000001" as import("../src/domain/primitives").CohortId;
  const second = "00000000-0000-4000-8000-000000000002" as import("../src/domain/primitives").CohortId;
  expect(transitionEffectWorkflowId({ kind: "cohort", id: first }, 1))
    .toBe(transitionEffectWorkflowId({ kind: "cohort", id: first }, 1));
  expect(transitionEffectWorkflowId({ kind: "cohort", id: first }, 1))
    .not.toBe(transitionEffectWorkflowId({ kind: "cohort", id: second }, 1));
});

// Retired event-row selection and SQL effect interpretation are replaced by a
// pure typed tree and atomic selected-decision persistence. Ledger guards above
// (single lifecycle writer, stable addresses, provenance) remain unchanged.
test("the cohort evaluator and selected changes have no IO imports", async () => {
  const files = ["decision/stage-machine.ts", "decision/stage-effects.ts"];
  const sources = await Promise.all(files.map((file) => readFile(join(SOURCE, file), "utf8")));
  expect(sources.join("\n")).not.toMatch(/(?:from\s+|import\s*\()["'][^"']*(?:storage|http|runtime|git|llm)[^"']*["']/i);
});

test("no source selects a first matching event transition", async () => {
  const sources = await Promise.all((await treeSources(SOURCE)).map((file) => readFile(file, "utf8")));
  expect(sources.join("\n")).not.toMatch(/export\s+const\s+transition\s*=|context\.registry\.guard\(|runStageEffectsIn/);
});

test("the dev-flow adapter has no PR guard or event progression registration", async () => {
  const source = await readFile(join(SOURCE, "adapters", "dev-flow.ts"), "utf8");
  expect(source).not.toMatch(/register_decision|guard\s*:|pull_request_observed|pull_request_merge_confirmed/);
});

test("runtime composition registers only the v15 run, stage and worker topology", async () => {
  const source = await readFile(join(SOURCE, "runtime", "compose.ts"), "utf8");
  expect(source).not.toMatch(/StageMachineRegistry|registerStageMachine|transitionWorkflow|legacyRunWorkflow|convertOldRun/);
  expect(source).toContain("registerRunRecordWorkflowServices");
  expect(source).toContain("WORKER_EXECUTION_WORKFLOW_NAME");
});

const LEGACY_EFFECT_INTERPRETATION = /(?:\.name\s*===\s*["'](?:launch_session|end_session|record_output|open_gate|accept_outputs|new_round)["']|switch\s*\(\s*(?:[\w.]+\.name|(?:effect_)?name)\s*\)\s*\{[\s\S]*?\bcase\s+["'](?:launch_session|end_session|record_output|open_gate|accept_outputs|new_round)["'])/;

test("storage never interprets legacy effect names to select progression", async () => {
  const files = await treeSources(join(SOURCE, "storage"));
  const sources = await Promise.all(files.map((file) => readFile(file, "utf8")));
  expect(sources.join("\n")).not.toMatch(LEGACY_EFFECT_INTERPRETATION);
});

test("the effect interpretation rule catches equality and switch cases", () => {
  expect([
    'effect.name === "launch_session"',
    "switch (effect.name) { case 'end_session': stop(); }",
    'switch (name) { case "record_output": write(); case "new_round": advance(); }',
    'switch (effect_name) { case "open_gate": open(); }',
    "switch (effect.name) { case 'accept_outputs': accept(); }",
  ].map((source) => LEGACY_EFFECT_INTERPRETATION.test(source))).toEqual([true, true, true, true, true]);
});

test("applying a typed selected change is not legacy effect interpretation", () => {
  expect(LEGACY_EFFECT_INTERPRETATION.test('switch (change.kind) { case "accept_outputs": apply(); }')).toBe(false);
});
