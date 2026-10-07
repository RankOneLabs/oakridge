import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import type { CoreClient } from "../src/core-client/client";
import { recoverConfiguredFailure, recoverStartFailure } from "../src/effects/operations/production-provider";
import { PROVIDER_ERROR_CODES } from "../src/effects/provider-catalog";
import type { StableInvocation } from "../src/effects/provider";
import type { SqlExecutor } from "../src/storage/sql-executor";

const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-config/definitions/development.json")).json();

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
