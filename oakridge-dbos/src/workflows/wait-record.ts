/**
 * The registry and durable steps through which the gate and handoff workflows
 * write their wait rows.
 *
 * A module-level holder with a throwing accessor, deliberately NOT the
 * optional-chaining observer shape: a silently skipped wait write is the exact
 * silent-loss class the wait table exists to kill. When the record cannot be
 * written, the owning workflow fails and the run halts visibly; it never
 * proceeds unrecorded.
 *
 * Lives apart from `production-topology.ts` because importing that from
 * `gate.ts` would be a cycle.
 */
import { DBOS } from "@dbos-inc/dbos-sdk";

import type { OpenGateWaitInput, OpenHandoffDownstreamWaitInput, WaitClosesOn, WaitKind, WaitOutcome } from "../domain/wait";
import type { WaitRepository } from "../storage/repositories";

let repository: WaitRepository | null = null;
export const registerWaitRepository = (value: WaitRepository): void => { repository = value; };
const waitRepository = (): WaitRepository => {
  if (!repository) throw new Error("wait repository is not registered");
  return repository;
};

export const openGateWaitStep = DBOS.registerStep(async (input: OpenGateWaitInput): Promise<void> =>
  waitRepository().open_gate(input),
{ name: "oakridgeOpenGateWaitStep", retriesAllowed: true });

export const openHandoffDownstreamWaitStep = DBOS.registerStep(async (input: OpenHandoffDownstreamWaitInput): Promise<void> =>
  waitRepository().open_handoff_downstream(input),
{ name: "oakridgeOpenHandoffDownstreamWaitStep", retriesAllowed: true });

export interface CloseWaitInput {
  readonly command_workflow_id: string;
  readonly kind: WaitKind;
  readonly outcome: WaitOutcome;
}
export const closeWaitStep = DBOS.registerStep(async (input: CloseWaitInput): Promise<void> =>
  waitRepository().close(input.command_workflow_id, input.kind, input.outcome),
{ name: "oakridgeCloseWaitStep", retriesAllowed: true });

export interface ReleaseDownstreamWaitInput {
  readonly command_workflow_id: string;
  readonly decided_outcome: Extract<WaitOutcome, { kind: "decided" }>;
  readonly external_closes_on: Extract<WaitClosesOn, { kind: "handoff_external" }>;
}
export const releaseDownstreamWaitStep = DBOS.registerStep(async (input: ReleaseDownstreamWaitInput): Promise<void> =>
  waitRepository().release_downstream(input.command_workflow_id, input.decided_outcome, input.external_closes_on),
{ name: "oakridgeReleaseDownstreamWaitStep", retriesAllowed: true });
