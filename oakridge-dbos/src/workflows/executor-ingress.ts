import type { Event, WorkerResult, Writer } from "../core-client/core-types";
import type { RunId } from "../domain/primitives";
import { commitEvent, type CommitDependencies, type CommitResult } from "../storage/commit";

/**
 * The executor's ingress (part 1 §7.1). The executor runs in-process, so its
 * credential is provenance: a report names only the attempt it is about, and
 * the writer is bound here to that attempt. No caller can hand in a writer.
 */
export type WorkerReport =
  /** `publication_secret_hash` is the hash of the secret minted for an agent's session; null when none was minted. */
  | { readonly kind: "started"; readonly session_id: string | null; readonly publication_secret_hash: string | null }
  | { readonly kind: "ended"; readonly result: WorkerResult }
  /**
   * A code worker's output, published by the action it ran (part 1 §7.2).
   * `predecessor` is the artifact's latest revision when the executor read it,
   * null for the first: step refuses a changed body on any other. The caller
   * resolves it once, so a re-sent report is the same event and replays.
   */
  | { readonly kind: "published"; readonly unit: string; readonly artifact: string; readonly body: unknown; readonly predecessor: string | null };
export interface ExecutorReport {
  readonly run_id: RunId;
  readonly attempt: { readonly action_id: string; readonly seq: number };
  readonly report: WorkerReport;
}

/** The event a report records; its ingress id is fixed by the attempt, so a re-run report replays. */
export function selectReportEvent(input: ExecutorReport): { readonly event: Event; readonly ingress_id: string } {
  const { action_id, seq } = input.attempt;
  const { report } = input;
  switch (report.kind) {
    case "started": return { event: { kind: "worker_started", action: action_id, kbbl_session_id: report.session_id },
      ingress_id: `worker_started:${action_id}:${seq}` };
    case "ended": return { event: { kind: "worker_ended", action: action_id, result: report.result },
      ingress_id: `worker_ended:${action_id}:${seq}` };
    case "published": return { event: { kind: "revision_published", unit: report.unit, artifact: report.artifact, body: report.body,
      predecessor: report.predecessor, subject: null, by: action_id }, ingress_id: `revision_published:${action_id}:${seq}:${report.artifact}` };
  }
}

/** One executor report, one commit, with the executor as writer. */
export function reportWorker(deps: CommitDependencies, input: ExecutorReport): Promise<CommitResult> {
  const { event, ingress_id } = selectReportEvent(input);
  const writer: Writer = { kind: "executor", attempt: input.attempt.action_id };
  const publication_secret_hash = input.report.kind === "started" ? input.report.publication_secret_hash : null;
  return commitEvent(deps, { run_id: input.run_id, ingress_id, event, writer, publication_secret_hash });
}
