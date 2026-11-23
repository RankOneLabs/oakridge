import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { selectClaimAnswer, type ClaimAnswer, type ExecutionEvidence, type ExecutionReconciliation, type KeyedExecutionRecovery } from "../domain/keyed-execution";
import type { RunId } from "../domain/primitives";
import { jsonText, type Database, type DatabaseTransaction } from "./database";
import type { CommitReceipt } from "./json-column-types";

interface ExecutionOwner {
  readonly run_id: string;
  readonly unit_id: string;
  readonly worker: string;
  readonly authorizing_revision_id: string;
}

export async function ensureKeyedExecution(trx: DatabaseTransaction, owner: ExecutionOwner): Promise<string> {
  const { run_id, unit_id, worker, authorizing_revision_id } = owner;
  const key = "xk_" + createHash("sha256").update(JSON.stringify([run_id, unit_id, worker, authorizing_revision_id])).digest("hex");
  const inserted = await trx.insertInto("authority.keyed_execution").values({ id: key, ...owner })
    .onConflict((conflict) => conflict.columns(["run_id", "authorizing_revision_id"]).doNothing())
    .returning("id").executeTakeFirst();
  if (inserted) return inserted.id;
  const existing = await trx.selectFrom("authority.keyed_execution").select(["id", "worker", "unit_id"])
    .where("run_id", "=", run_id).where("authorizing_revision_id", "=", authorizing_revision_id).executeTakeFirstOrThrow();
  if (existing.worker !== worker || existing.unit_id !== unit_id) throw new Error("Authorizing revision already belongs to another execution worker");
  return existing.id;
}

type ExecutionMutation =
  | { readonly kind: "claim"; readonly recovery: KeyedExecutionRecovery; readonly action_id: string }
  | { readonly kind: "evidence"; readonly evidence: ExecutionEvidence; readonly action_id: string }
  | { readonly kind: "reconcile"; readonly outcome: ExecutionReconciliation };
interface ExecutionRequest {
  readonly run_id: string;
  readonly unit_id: string;
  readonly key: string;
  readonly request_id: string;
  readonly mutation: ExecutionMutation;
}
type ExecutionResult = { readonly kind: "ok"; readonly answer?: ClaimAnswer; readonly event_id?: string }
  | { readonly kind: "missing" | "conflict" | "unauthorized"; readonly detail: string };
type RetryExecution = (trx: DatabaseTransaction, worker: string) => Promise<{ readonly event_id: string } | { readonly reason: string }>;

export async function mutateKeyedExecution(db: Database, request: ExecutionRequest, retry: RetryExecution): Promise<ExecutionResult> {
  const { run_id, unit_id, key, mutation } = request;
  return db.transaction().execute(async (trx) => {
    const run = await trx.selectFrom("authority.run").select("id").where("id", "=", run_id).forUpdate().executeTakeFirst();
    if (!run) return { kind: "missing", detail: "run not found" };
    const record = await trx.selectFrom("authority.keyed_execution").selectAll()
      .where("id", "=", key).where("run_id", "=", run_id).where("unit_id", "=", unit_id).executeTakeFirst();
    if (!record) return { kind: "missing", detail: "execution not found" };
    if ("action_id" in mutation) {
      const attempt = await trx.selectFrom("authority.attempt as attempt")
        .innerJoin("authority.effect_intent as intent", (join) => join
          .onRef("intent.action_id", "=", "attempt.action_id").onRef("intent.seq", "=", "attempt.seq"))
        .select("intent.payload").where("attempt.run_id", "=", run_id).where("attempt.unit_id", "=", unit_id)
        .where("attempt.action_id", "=", mutation.action_id).where("attempt.worker", "=", record.worker)
        .where((eb) => eb(eb.ref("attempt.status", "->>").key("kind"), "=", "running")).executeTakeFirst();
      if (attempt?.payload.execution_key !== key) return { kind: "unauthorized", detail: "execution does not belong to the running attempt" };
    }

    const ingress_id = `execution:${key}:${"action_id" in mutation ? mutation.action_id : "operator"}:${request.request_id}`;
    const digest = createHash("sha256").update(JSON.stringify(mutation.kind === "claim" ? { kind: mutation.kind } : mutation)).digest("hex");
    const receipt = await trx.selectFrom("authority.ingress_receipt").select(["result", "request_digest"])
      .where("run_id", "=", run_id).where("ingress_id", "=", ingress_id).executeTakeFirst();
    if (receipt) {
      if (receipt.request_digest !== digest) return { kind: "conflict", detail: "request_id reused with different content" };
      if (receipt.result.kind === "rejected") return { kind: "conflict", detail: receipt.result.reason };
      if (receipt.result.execution_answer?.kind !== "launch") {
        return { kind: "ok", answer: receipt.result.execution_answer, event_id: receipt.result.event_id };
      }
      return { kind: "conflict", detail: "the launch claim was already recorded; claim again with a new request_id to resume or reconcile" };
    }
    const storeReceipt = (result: CommitReceipt) => trx.insertInto("authority.ingress_receipt")
      .values({ id: crypto.randomUUID(), run_id, unit_id, ingress_id, request_digest: digest, result: jsonText(result) }).execute();
    const reject = async (reason: string): Promise<ExecutionResult> => {
      await storeReceipt({ kind: "rejected", reason });
      return { kind: "conflict", detail: reason };
    };
    const update = () => trx.updateTable("authority.keyed_execution").where("id", "=", key);
    let answer: ClaimAnswer | undefined;
    let event_id: string = crypto.randomUUID();
    if (mutation.kind === "claim") {
      const transition = selectClaimAnswer(record, mutation.recovery);
      answer = transition.answer;
      if (transition.next_state !== record.state) {
        await update().set({ state: transition.next_state, updated_at: new Date(),
          ...(answer.kind === "launch" ? { claim_count: record.claim_count + 1, claimed_by_action_id: mutation.action_id } : {}) }).execute();
        if (transition.next_state === "reconcile") {
          await trx.insertInto("authority.operator_event").values({ id: crypto.randomUUID(), run_id, run_key: run_id,
            payload: jsonText({ kind: "invalidate", data: { target: "run", run_id: run_id as RunId } }) }).execute();
        }
      }
    } else if (mutation.kind === "evidence") {
      if (record.evidence && !isDeepStrictEqual(record.evidence, mutation.evidence)) return reject("different evidence is already attached");
      if (!record.evidence && record.state !== "claimed") return reject("execution must have an active claim to attach evidence");
      if (!record.evidence) await update().set({ state: "evidence_attached", evidence: jsonText(mutation.evidence), updated_at: new Date() }).execute();
    } else {
      if (record.state !== "reconcile") return reject("execution is not awaiting reconciliation");
      const result = await retry(trx, record.worker);
      if ("reason" in result) return reject(result.reason);
      event_id = result.event_id;
      const evidence = mutation.outcome.kind === "evidence" ? jsonText(mutation.outcome.evidence) : null;
      await update().set({ state: evidence ? "evidence_attached" : "unclaimed", evidence,
        reconciliation: jsonText(mutation.outcome), claimed_by_action_id: null, updated_at: new Date() }).execute();
    }
    await storeReceipt({ kind: "committed", event_id, ...(answer ? { execution_answer: answer } : {}) });
    return { kind: "ok", answer, event_id };
  });
}
