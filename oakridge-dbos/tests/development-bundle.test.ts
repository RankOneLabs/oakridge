import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { repository } from "./development-runtime-fixture";
import { CoreClient } from "../src/core-client/client";
import { promptWithActionInput } from "../src/effects/operations/selected-request";
import { pinProviderRequest, resolveSelectedSessionSettings } from "../src/effects/operations/selected-request";
import { selectedInvocation, type InvocationId } from "../src/effects/provider";
import type { RunId, ScopeId } from "../src/storage/schema-records";
import { readAuthoredPrompt } from "../src/storage/prompt-content";
import { createMutationService } from "../src/storage/mutation-service";
import type { DefinitionSummary } from "../src/projections/definition-view";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import type { CheckedValue, DefinitionBundle, Snapshot } from "../src/core-client/generated-contracts";

const root = resolve(import.meta.dir, "../..");
const bundle: DefinitionBundle = await Bun.file(resolve(root, "workflow-config/definitions/development.json")).json();
const binary = resolve(root, "workflow-core/target/debug/workflow-cli");
const unit: CheckedValue = { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } };

function client(): CoreClient {
  const result = CoreClient.start({ binary, deadlineMs: 5_000 });
  if (!result.ok) throw new Error(result.error.detail.detail);
  return result.value;
}

async function checked(core: CoreClient, schema: string, payload: unknown): Promise<CheckedValue> {
  const result = await core.request("validate_payload", { bundle, schema, payload });
  if (!result.ok || result.value.kind !== "validated") throw new Error(JSON.stringify(result));
  return result.value.value;
}

function snapshot(scope: string, input: CheckedValue, state_schema: string, state: string, trigger: string, payload: CheckedValue = unit,
  observations: Snapshot["observations"] = []): Snapshot {
  return { owner: `scope:${scope}`, scope, version: 1, input,
    state: { schema: state_schema, data: { kind: "variant", variant: state, value: unit } },
    trigger: { id: `trigger:${trigger}`, key: trigger, payload }, observations, timestamp_ms: 1, random_seed: 1 };
}

test("development declaration compiles against the generic core", async () => {
  const core = client();
  try {
    const result = await core.request("compile", { bundle });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe("compiled");
  } finally { core.close(); }
});

test("prompt bytes and pinned digest reproduce the generated source", async () => {
  for (const prompt of bundle.prompts) {
    const bytes = await Bun.file(resolve(root, prompt.path)).bytes();
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(prompt.content_digest);
    expect("content" in prompt).toBe(false);
  }
  const core = client();
  try {
    let saved: DefinitionSummary | null = null;
    const query = async (sql: string, params: unknown[]) => {
      if (sql.startsWith("INSERT INTO authority.definition_bundle")) { saved = { bundle_id: params[0] as string, digest: params[1] as string, source: bundle, archived_at: null }; return []; }
      if (sql.includes("FROM authority.definition_bundle")) return saved ? [saved] : [];
      return [];
    };
    const db = { query, transaction: async (operation: (tx: unknown) => Promise<unknown>) => operation({ query }) } as unknown as TransactionalSqlExecutor;
    const pinned = await createMutationService(db, core, { probe: async () => ({ ok: true, value: true }),
      check_github: async () => ({ ok: true, value: true }) }).pinDefinition({ bundle });
    const compiled = await core.request("compile", { bundle });
    expect(pinned.ok && compiled.ok && compiled.value.kind === "compiled" ? pinned.value.digest : null)
      .toBe(compiled.ok && compiled.value.kind === "compiled" ? compiled.value.value.digest : null);
  } finally { core.close(); }
});

test("pinning rejects changed prompt bytes and paths outside the configured root", async () => {
  const core = client();
  try {
    // No prompt is stored yet, so pinning reads and verifies the authored files.
    const service = createMutationService({ query: async () => [] } as unknown as TransactionalSqlExecutor, core);
    const prompt = bundle.prompts[0];
    if (!prompt) throw new Error("prompt fixture missing");
    const changed = await service.pinDefinition({ bundle: { ...bundle, prompts: [{ ...prompt, content_digest: "0".repeat(64) }, ...bundle.prompts.slice(1)] } });
    expect(changed).toMatchObject({ ok: false, error: { operation: "pin_definition", detail: expect.stringContaining("digest mismatch") } });
    const escaped = await service.pinDefinition({ bundle: { ...bundle, prompts: [{ ...prompt, path: "../secret" }, ...bundle.prompts.slice(1)] } });
    expect(escaped).toMatchObject({ ok: false, error: { operation: "pin_definition", detail: expect.stringContaining("outside the configured allowlist") } });
  } finally { core.close(); }
});

test("starting an inline bundle rejects invalid prompts before compilation or storage", async () => {
  const prompt = bundle.prompts[0];
  if (!prompt) throw new Error("prompt fixture missing");
  let compiled = false;
  let stored = false;
  const core = { request: async () => { compiled = true; throw new Error("unexpected compilation"); } } as unknown as CoreClient;
  const db = { query: async () => [], transaction: async () => { stored = true; throw new Error("unexpected storage"); } } as unknown as TransactionalSqlExecutor;
  const service = createMutationService(db, core);
  const changed = await service.startRun({ bundle: { ...bundle, prompts: [{ ...prompt, content_digest: "0".repeat(64) }, ...bundle.prompts.slice(1)] }, input: {} });
  expect(changed).toMatchObject({ ok: false, error: { operation: "start_run", detail: expect.stringContaining("digest mismatch") } });
  const escaped = await service.startRun({ bundle: { ...bundle, prompts: [{ ...prompt, path: "../secret" }, ...bundle.prompts.slice(1)] }, input: {} });
  expect(escaped).toMatchObject({ ok: false, error: { operation: "start_run", detail: expect.stringContaining("outside the configured allowlist") } });
  expect({ compiled, stored }).toEqual({ compiled: false, stored: false });
});

test("selected prompt carries its pinned action input", () => {
  expect(promptWithActionInput("Review this build", { feedback: "fix scope", revision: "build-2" }))
    .toContain('"revision": "build-2"');
});

test("development prompt lookup preserves the rendered prompt bytes", () => {
  const action = bundle.scopes.flatMap((scope) => scope.workers.flatMap((worker) => worker.actions))
    .find((candidate) => candidate.prompt !== null && candidate.prompt !== undefined);
  const authored = bundle.prompts.find((prompt) => prompt.key === action?.prompt);
  if (!action?.prompt || !authored) throw new Error("development prompt fixture missing");
  const action_input = { repository: "oakridge", instruction: "Build the pinned scope" };
  const content = readAuthoredPrompt(authored);
  if (!content.ok) throw new Error(content.error.detail);
  const previous = promptWithActionInput(content.value.content, action_input);
  const resolved = bundle.prompts.find((prompt) => prompt.key === action.prompt);
  if (!resolved) throw new Error("prompt missing");
  const reread = readAuthoredPrompt(resolved);
  if (!reread.ok) throw new Error(reread.error.detail);
  expect(promptWithActionInput(reread.value.content, action_input)).toBe(previous);
});

test("selected child session pins policy model and effort in the provider bytes", async () => {
  const core = client();
  try {
    const action = bundle.scopes.find((scope) => scope.key === "implementation")!.workers.find((worker) => worker.key === "build")!.actions.find((item) => item.operation === "session.run")!;
    const input = await checked(core, "session_action", { selector: { stage_key: "implementation", cohort_key: "c02", worker_key: "build", action_key: action.key },
      config: { runtime: "codex", workdir: "/tmp", session_name: "build" }, context: {} });
    const selection = { definition: action, selection: { worker: "build", action: action.key }, input };
    const scope = { id: "child" as ScopeId, run_id: "run" as RunId, scope_key: "implementation", child_key: "c02", collection_key: "cohorts" };
    const policy = { version: 3, entries: [{ selector: { kind: "cohort" as const, stage_key: "implementation", cohort_key: "c02" },
      settings: { runtime: null, model: "gpt-6-sol", effort: "high" } }] };
    const settings = resolveSelectedSessionSettings(bundle, selection, scope, policy);
    expect(settings).toMatchObject({ ok: true, value: { model: "gpt-6-sol", effort: "high", policy_version: 3 } });
    const mismatched = await checked(core, "session_action", { selector: { stage_key: "planning", cohort_key: "c02", worker_key: "build", action_key: action.key },
      config: { runtime: "codex", workdir: "/tmp", session_name: "build" }, context: {} });
    expect(resolveSelectedSessionSettings(bundle, { ...selection, input: mismatched }, scope, policy))
      .toMatchObject({ ok: false, error: { detail: "session selector disagrees with selected action" } });
    if (!settings.ok) throw new Error(settings.error.detail);
    const selected = selectedInvocation("invocation" as InvocationId, "execution", selection, settings.value);
    const pinned = pinProviderRequest({ invocation: selected, bundle, prompts: new Map([[action.prompt!, "Build the cohort"]]), scope, publication_secret: "secret" });
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) throw new Error(pinned.error.detail);
    expect(pinned.value.session_settings).toEqual(settings.value);
    expect(JSON.parse(pinned.value.bytes)).toMatchObject({ runtime: "codex", model: "gpt-6-sol", effort: "high" });
  } finally { core.close(); }
});

test("root selects repository preparation from the repository configuration collection", async () => {
  const core = client();
  try {
    const config = { runtime: "codex", workdir: "/tmp", session_name: "development" };
    const root_input = await checked(core, "run_input", { spec: "Implement feature", repositories: [repository], analysis: config, planning: config, briefs: config });
    const result = await core.request("evaluate", { bundle,
      snapshot: snapshot("development", root_input, "phase_root", "ready", "begin") });
    expect(result).toMatchObject({ ok: true, value: { kind: "evaluated", value: { kind: "apply", mutations: expect.arrayContaining([expect.objectContaining({ kind: "activate_collection", key: "prepare" })]) } } });
  } finally { core.close(); }
});

test("a run that names no repository is refused at begin rather than starting an empty stage", async () => {
  const core = client();
  try {
    const config = { runtime: "codex", workdir: "/tmp", session_name: "development" };
    const root_input = await checked(core, "run_input", { spec: "Implement feature", repositories: [], analysis: config, planning: config, briefs: config });
    const result = await core.request("evaluate", { bundle,
      snapshot: snapshot("development", root_input, "phase_root", "ready", "begin") });
    expect(result).toMatchObject({ ok: true, value: { kind: "evaluated", value: { kind: "reject", error: "invalid_command" } } });
  } finally { core.close(); }
});
