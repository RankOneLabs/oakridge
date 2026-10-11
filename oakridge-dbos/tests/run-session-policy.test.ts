import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CheckedValue, DefinitionBundle } from "../src/core-client/generated-contracts";
import { policyFromRunInput } from "../src/domain/run-session-policy";
import { resolveSessionSettings, type SessionSettingsContext } from "../src/domain/session-settings";
import { readRunPolicy } from "../src/storage/snapshot-reader";
import type { SqlExecutor } from "../src/storage/sql-executor";

const defaults: SessionSettingsContext["worker_defaults"] = [
  { runtime: "claude-code", model: "opus" }, { runtime: "codex", model: "gpt-5.6-sol" },
];
const settings = (model: string, effort: string) => ({ runtime: "codex", model, effort });

test("pinned role choices select the planner for assessment and worker for build", () => {
  const parsed = policyFromRunInput({ sessions: {
    planner: settings("gpt-6-astra", "high"), worker: settings("gpt-6-luna", "low"),
  } });
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const context = (worker_key: string): SessionSettingsContext => ({ stage_key: "implementation", cohort_key: "cohort",
    worker_key, action_key: "initial", worker_defaults: defaults });
  const assessment = resolveSessionSettings(parsed.value, context("assessment"));
  const build = resolveSessionSettings(parsed.value, context("build"));
  expect([assessment.ok && assessment.value.model, build.ok && build.value.model]).toEqual(["gpt-6-astra", "gpt-6-luna"]);
  expect([assessment.ok && assessment.value.effort, build.ok && build.value.effort]).toEqual(["high", "low"]);
});

test("stage overrides planner while build keeps the worker choice", () => {
  const parsed = policyFromRunInput({ sessions: {
    planner: settings("gpt-6-astra", "high"), worker: settings("gpt-6-luna", "low"),
    planning: settings("gpt-6-sol", "medium"), implementation: settings("gpt-6-sol", "medium"),
  } });
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const context = (stage_key: string, worker_key: string): SessionSettingsContext => ({ stage_key, cohort_key: null,
    worker_key, action_key: "initial", worker_defaults: defaults });
  const planning = resolveSessionSettings(parsed.value, context("planning", "author"));
  const assessment = resolveSessionSettings(parsed.value, context("implementation", "assessment"));
  const build = resolveSessionSettings(parsed.value, context("implementation", "build"));
  expect([planning.ok && planning.value.model, assessment.ok && assessment.value.model, build.ok && build.value.model])
    .toEqual(["gpt-6-sol", "gpt-6-sol", "gpt-6-luna"]);
});

test("malformed role settings fail rather than silently falling back", () => {
  expect(policyFromRunInput({ sessions: { planner: { runtime: "codex", model: 5, effort: null } } }))
    .toMatchObject({ ok: false, error: { entity_id: "sessions.planner" } });
});

test("snapshot reader derives session policy from the stored checked root input", async () => {
  const bundle = JSON.parse(readFileSync(new URL("../../workflow-config/definitions/development.json", import.meta.url), "utf8")) as DefinitionBundle;
  const root = bundle.scopes.find((scope) => scope.key === bundle.root);
  const root_shape = bundle.schemas.find((schema) => schema.key === root?.input_schema)?.shape;
  if (!root || root_shape?.kind !== "record") throw new Error("shipped root schema missing");
  const sessions_field_id = root_shape.fields.findIndex((field) => field.key === "sessions");
  if (sessions_field_id < 0) throw new Error("shipped sessions field missing");
  const setting = (model: string): CheckedValue => ({ schema: "session_settings", data: { kind: "record", dictionary: [], fields: [
    { field_id: 0, value: { schema: "optional_runtime", data: { kind: "optional", value: { schema: "runtime", data: { kind: "enum", variant: "codex" } } } } },
    { field_id: 1, value: { schema: "optional_ident", data: { kind: "optional", value: { schema: "ident", data: { kind: "string", value: model } } } } },
    { field_id: 2, value: { schema: "optional_ident", data: { kind: "optional", value: null } } },
  ] } });
  const input: CheckedValue = { schema: root.input_schema, data: { kind: "record", dictionary: [], fields: [
    { field_id: sessions_field_id, value: { schema: "run_sessions", data: { kind: "record", dictionary: [], fields: [
      { field_id: 0, value: setting("gpt-6-astra") }, { field_id: 1, value: setting("gpt-6-luna") },
    ] } } },
  ] } };
  const tx: SqlExecutor = { async query<Row extends object>(statement: string): Promise<readonly Row[]> {
    const rows = statement.includes("FROM authority.run r")
      ? [{ run_id: "run", project_id: null, session_policy: null }]
      : [{ input, source: bundle }];
    return rows as unknown as readonly Row[];
  } };
  const result = await readRunPolicy(tx, "run");
  expect(result.policy.entries).toEqual([
    { selector: { kind: "run" }, settings: { runtime: "codex", model: "gpt-6-astra", effort: null } },
    { selector: { kind: "stage_worker", stage_key: "implementation", worker_key: "build" },
      settings: { runtime: "codex", model: "gpt-6-luna", effort: null } },
  ]);
});
