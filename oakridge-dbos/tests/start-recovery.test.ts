import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { CoreClient } from "../src/core-client/client";
import { createEffectProvider, recoverConfiguredFailure, recoverStartFailure } from "../src/effects/operations/production-provider";
import { asKbblCredential } from "../src/adapters/kbbl";
import { PROVIDER_ERROR_CODES } from "../src/effects/provider-catalog";
import type { InvocationId, StableInvocation } from "../src/effects/provider";
import type { SqlExecutor } from "../src/storage/sql-executor";

const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-config/definitions/development.json")).json();

function boundedRecoveryBundle(max_length: number): DefinitionBundle {
  const recovery_facts = new Set(bundle.operations.flatMap((operation) => operation.recovery?.map((mapping) => mapping.fact) ?? []));
  return { ...bundle, schemas: [...bundle.schemas, { key: "recovery_detail", shape: { kind: "string", min_length: 0, max_length } }],
    scopes: bundle.scopes.map((scope) => ({ ...scope,
      facts: scope.facts.map((fact) => recovery_facts.has(fact.key) ? { ...fact, payload_schema: "recovery_detail" } : fact) })) };
}

async function withRecoveryCore(use: (core: CoreClient) => Promise<void>): Promise<void> {
  const started = CoreClient.start({ binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), deadlineMs: 10_000 });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  try { await use(started.value); } finally { started.value.close(); }
}

const bounded_details = [
  { name: "zero-length schema", max_length: 0, detail: "provider unavailable", expected: "" },
  { name: "one-character schema", max_length: 1, detail: "provider unavailable", expected: "p" },
  { name: "Unicode scalar bounds", max_length: 1, detail: "😀 unavailable", expected: "😀" },
  { name: "detail within bounds", max_length: 10, detail: "failed", expected: "failed" },
];
for (const item of bounded_details) test(`configured start failures retain evidence with ${item.name}`, async () => {
  const source = boundedRecoveryBundle(item.max_length);
  const invocation = { id: "bounded-failure", execution_id: "execution",
    selection: { definition: { operation: "session.run", contract_version: 1 } } } as unknown as StableInvocation;
  const db = { query: async () => [{ source, scope_key: "spec_analysis", scope_id: "scope", run_id: "run" }] } as unknown as SqlExecutor;
  await withRecoveryCore(async (core) => {
    const compiled = await core.request("compile", { bundle: source });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
    for (const code of [PROVIDER_ERROR_CODES.start_rejected, PROVIDER_ERROR_CODES.start_attempts_exhausted]) {
      expect(await recoverConfiguredFailure({ db, core, invocation, code, detail: item.detail })).toMatchObject({
        kind: "permanently_rejected", code, detail: item.detail,
        evidence: { key: "session_failed", payload: { schema: "recovery_detail", data: { kind: "string", value: item.expected } } },
      });
    }
  });
});

test("unmapped permanent failures retain bounded fallback evidence", async () => {
  const source = boundedRecoveryBundle(1);
  const invocation = { id: "bounded-fallback", execution_id: "execution",
    selection: { definition: { operation: "repository.prepare", contract_version: 1 } } } as unknown as StableInvocation;
  const db = { query: async () => [{ source, scope_key: "repository_preparation", scope_id: "scope", run_id: "run" }] } as unknown as SqlExecutor;
  await withRecoveryCore(async (core) => {
    expect(await recoverStartFailure({ db, core, invocation, code: PROVIDER_ERROR_CODES.worktree_unrecoverable, detail: "missing worktree" }))
      .toMatchObject({ kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.start_rejected,
        evidence: { key: "provider_start_failed", payload: { data: { kind: "string", value: "w" } } } });
  });
});

test("direct provider rejections retain their full diagnostic and bounded recovery evidence", async () => {
  const bounded = boundedRecoveryBundle(1);
  const source: DefinitionBundle = { ...bounded, operations: bounded.operations.map((operation) => operation.key === "repository.prepare"
    ? { ...operation, recovery: [...(operation.recovery ?? []), { code: PROVIDER_ERROR_CODES.worktree_unrecoverable, fact: "provider_start_failed" }] }
    : operation) };
  const scope = source.scopes.find((scope) => scope.key === "repository_preparation");
  const worker = scope?.workers.find((worker) => worker.key === "preparation");
  const action = worker?.actions.find((action) => action.operation === "repository.prepare");
  if (!worker || !action) throw new Error("repository preparation fixture missing");
  const invocation: StableInvocation = { id: "bounded-provider" as InvocationId, execution_id: "execution",
    selection: { selection: { worker: worker.key, action: action.key }, definition: action,
      input: { schema: "unit", data: { kind: "record", fields: [], dictionary: [] } } },
    request: { version: 1, kind: "repository_preparation" }, bytes: JSON.stringify({ repository_path: "/missing", expected_head: null }) };
  const db = { query: async () => [{ source, scope_key: "repository_preparation", scope_id: "scope", run_id: "run" }] } as unknown as SqlExecutor;
  await withRecoveryCore(async (core) => {
    const provider = createEffectProvider({ db, core, kbbl_base_url: "http://unused", credential: asKbblCredential("test-token"),
      git: { run: async () => ({ exit_code: 1, stdout: "", stderr: "missing worktree" }) } });
    expect(await provider.start(invocation)).toMatchObject({ kind: "permanently_rejected",
      code: PROVIDER_ERROR_CODES.worktree_unrecoverable, detail: "repository at /missing cannot be inspected: missing worktree",
      evidence: { key: "provider_start_failed", payload: { data: { kind: "string", value: "r" } } } });
  });
});

test("permanent and exhausted starts resolve to configured facts for every shipped provider", async () => {
  const cases = [
    { operation: "repository.prepare", scope: "repository_preparation", fact: "provider_start_failed" },
    { operation: "session.run", scope: "spec_analysis", fact: "session_failed" },
    { operation: "pull_request.observe", scope: "implementation", fact: "provider_start_failed" },
  ];
  for (const item of cases) for (const code of [PROVIDER_ERROR_CODES.start_rejected, PROVIDER_ERROR_CODES.start_attempts_exhausted]) {
    const invocation = { id: `${item.operation}:${code}`, execution_id: "execution",
      selection: { definition: { operation: item.operation, contract_version: 1 } } } as unknown as StableInvocation;
    const db = { query: async () => [{ source: bundle, scope_key: item.scope, scope_id: "scope", run_id: "run" }] } as unknown as SqlExecutor;
    const core = { request: async (_operation: string, input: { schema: string; payload: unknown }) => ({ ok: true,
      value: { kind: "validated", value: { schema: input.schema, data: { kind: "string", value: input.payload } } } }) } as unknown as CoreClient;
    const result = await recoverConfiguredFailure({ db, core, invocation, code, detail: "start failed" });
    expect(result).toMatchObject({ kind: "permanently_rejected", evidence: { key: item.fact,
      payload: { data: { kind: "string", value: "start failed" } } } });
  }
});

test("an unmapped permanent provider code uses the configured start rejection trigger", async () => {
  const invocation = { id: "repo-rejection", execution_id: "execution",
    selection: { definition: { operation: "repository.prepare", contract_version: 1 } } } as unknown as StableInvocation;
  const db = { query: async () => [{ source: bundle, scope_key: "repository_preparation", scope_id: "scope", run_id: "run" }] } as unknown as SqlExecutor;
  const core = { request: async (_operation: string, input: { schema: string; payload: unknown }) => ({ ok: true,
    value: { kind: "validated", value: { schema: input.schema, data: { kind: "string", value: input.payload } } } }) } as unknown as CoreClient;
  const result = await recoverStartFailure({ db, core, invocation, code: PROVIDER_ERROR_CODES.worktree_unrecoverable, detail: "missing worktree" });
  expect(result).toMatchObject({ kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.start_rejected,
    evidence: { key: "provider_start_failed" } });
});

test("runtime control flow never reads the diagnostic last_detail field", async () => {
  const root = resolve(import.meta.dir, "../src");
  const readers: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
    if (/\b(?:payload|outcome\.payload|intent\.payload)\.last_detail\b/.test(await Bun.file(resolve(root, path)).text())) readers.push(path);
  }
  expect(readers).toEqual([]);
});
