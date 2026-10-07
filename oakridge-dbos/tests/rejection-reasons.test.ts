import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { deliverEvidence } from "../src/effects/evidence";
import type { EffectIntent } from "../src/effects/intents";
import type { MutationService } from "../src/storage/mutation-service";
import type { TransactionalSqlExecutor } from "../src/storage/sql-executor";
import type { CommitRejectionReason } from "../src/storage/commit";

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
