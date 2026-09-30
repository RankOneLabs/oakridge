import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { ok, type JsonValue } from "../src/domain/primitives";
import { AdapterRegistry } from "../src/runtime/executor-registry";
import { cohortMachineAddress } from "../src/workflows/run-record-topology";
import { BUILD_LAUNCH_REASONS } from "../src/adapters/dev-flow-build";

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

test("core decision sources contain no dev-flow payload, role, event, or sentinel identifiers", async () => {
  const files = [...await decisionSources(), join(SOURCE, "domain", "records.ts")];
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
  for (const reason of Object.values(BUILD_LAUNCH_REASONS).flat()) {
    expect(decision).not.toContain(reason);
    expect(baseline).not.toContain(reason);
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
  const adapter = await readFile(join(SOURCE, "domain", "final-pull-request.ts"), "utf8");
  expect(adapter).toContain("repository.integration_branch");
  expect(adapter).toContain("profile.final_merge_policy");
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
 *
 * `UPDATE` only, and the `SET` has to follow the table directly — at most an
 * alias between them. No lifecycle status is written by an upsert, and allowing
 * `INSERT INTO` with an unbounded bridge to a later `SET` let one template
 * literal's insert pair with a different statement's `SET status=` and flag the
 * file. The clause body may not cross into another statement either.
 */
const LIFECYCLE_TABLES = ["workflow_run", "stage_instance", "cohort", "attempt", "session"];
const LIFECYCLE_STATUS_WRITE = new RegExp(
  `UPDATE\\s+oakridge\\.(?:${LIFECYCLE_TABLES.join("|")})\\b(?:\\s+\\w+)?\\s+SET\\b`
  + "(?:(?!UPDATE|INSERT|DELETE)[^;`])*?\\bstatus\\s*=",
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

test("the lifecycle rule does not pair one statement's table with another's status write", () => {
  expect(LIFECYCLE_STATUS_WRITE.test(
    "INSERT INTO oakridge.attempt (id) VALUES ($1)\nUPDATE oakridge.wait_gate SET status='closed'")).toBe(false);
  expect(LIFECYCLE_STATUS_WRITE.test(
    "UPDATE oakridge.attempt SET ended_at=now()\nUPDATE oakridge.artifact_thread SET status=$2")).toBe(false);
});

test("each cohort has one stable machine address", () => {
  const first = "00000000-0000-4000-8000-000000000001" as import("../src/domain/primitives").CohortId;
  const second = "00000000-0000-4000-8000-000000000002" as import("../src/domain/primitives").CohortId;
  expect(cohortMachineAddress(first)).toEqual(cohortMachineAddress(first));
  expect(cohortMachineAddress(first).workflow_id).not.toBe(cohortMachineAddress(second).workflow_id);
});
