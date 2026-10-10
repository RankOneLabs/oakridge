import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { deliverEvidence } from "../src/effects/evidence";
import type { EffectIntent } from "../src/effects/intents";
import type { MutationService } from "../src/storage/mutation-service";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import type { CommitRejectionReason } from "../src/storage/commit";
import type { CommitRequest } from "../src/storage/commit";
import type { AuthoritySnapshot } from "../src/storage/snapshot-reader";
import type { SqlExecutor } from "../src/storage/sql-executor";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { validateStorageAuthority } from "../src/storage/storage-validator";

const rejectionDetailMatch = /\b(?:outcome|rejection|commit_result|result\.value)\.detail\s*(?:===|!==|==|!=|\.startsWith\s*\(|\.includes\s*\()/;

test("commit rejection control flow never compares human detail text", async () => {
  const root = resolve(import.meta.dir, "../src");
  const violations: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: root })) {
    const source = await Bun.file(resolve(root, path)).text();
    if (rejectionDetailMatch.test(source) || source.includes("BENIGN_REJECTIONS")) violations.push(path);
  }
  expect(violations).toEqual([]);
});

test("the rejection detail guard catches equality and prefix branching", () => {
  expect([
    'outcome.detail === "terminal"',
    'rejection.detail.startsWith("capacity/")',
  ].every((source) => rejectionDetailMatch.test(source))).toBe(true);
});

test("evidence delivery treats the reason as authoritative when detail text changes", async () => {
  const db = { query: async () => [{ run_id: "run" }], transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ query: async () => [] }) } as unknown as TransactionalSqlExecutor;
  const intent = { id: "effect", scope_id: "scope" as import("../src/storage/schema-records").ScopeId,
    execution_id: null, payload: { evidence: { id: "evidence", key: "failure",
      payload: { schema: "unit", data: { kind: "record" as const, fields: [], dictionary: [] } } } } } as unknown as Pick<EffectIntent, "id" | "scope_id" | "execution_id" | "payload">;
  const deliver = (reason: CommitRejectionReason, detail: string) => deliverEvidence(db,
    { decide: async () => ({ ok: true, value: { kind: "Rejected", reason, detail } }) } as unknown as MutationService, intent);
  expect(await deliver("owner_terminal", "the wording changed")).toEqual({ kind: "delivered" });
  expect(await deliver("invalid", "owner is terminal")).toEqual({ kind: "deferred", detail: "owner is terminal" });
});

test("only the declared edit trigger permits a publication without an execution", async () => {
  const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-config/definitions/development.json")).json();
  const source = { owner: { id: "scope", run_id: "run", scope_key: "implementation" },
    snapshot: { trigger: { key: "build_submitted" } } } as AuthoritySnapshot;
  const request = { decision: { kind: "wait" }, outputs: [{ output_key: "build_result", collection_key: "",
    execution_id: null }], capacity: [] } as unknown as CommitRequest;
  const tx = { query: async () => [] } as unknown as SqlExecutor;
  expect(await validateStorageAuthority(tx, request, source, bundle)).toMatchObject({ ok: false,
    error: { detail: "producer execution required" } });
  const edit_source = { ...source, snapshot: { ...source.snapshot, trigger: { key: "edit_build_result" } } } as AuthoritySnapshot;
  expect(await validateStorageAuthority(tx, request, edit_source, bundle)).toMatchObject({ ok: true });
});
