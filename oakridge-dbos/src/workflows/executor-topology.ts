import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ArtifactEnvelope, ExecutionRequest, ExecutorAdapter, ExecutorObservationAttempt, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import { executorOperationIdForAttempt, type ExecutionAttemptId } from "../domain/primitives";
import { gateRelayWorkflowId, gateWaitWorkflowId, gateWaitWorkflowIdFromRelay, handoffWorkflowId, terminalObserverWorkflowId } from "../domain/workflow-ids";
import type { CollaborationPingRequest, CollaborationPingState } from "../domain/collaboration";
import { selectRevisionTarget, type ArtifactReleaseState, type ArtifactRevision, type ExecutionContractState, type ReleaseArtifactResult } from "../domain/artifacts";
import type { CompiledOutputContract, GateRevisionTarget } from "../domain/compiled-workflow";
import { evaluateExecutionArtifactContract, shouldAwaitArtifactRelease, withoutReleaseFor, withRelease } from "../contracts/evaluate-artifacts";
import { durableGateWorkflow, type GateCommand, type GateWaitInput } from "./gate";
import { durableHandoffWorkflow, type HandoffCommand, type HandoffResult } from "./handoff";
import { selectGateDisposition, type GateDisposition } from "../domain/gates";
import { selectOutputVisibility, type OutputVisibility } from "../domain/output-availability";
// Type-only, so the cycle with the topology that starts this workflow is
// erased at compile time and never exists at runtime.
import type { StageSignal } from "./production-topology";

const adapters = new Map<string, ExecutorAdapter>();
export interface ExecutionProjectionObserver {
  attach_external(execution_id: ExecutionRequest["execution_id"], reference: ExternalExecutionReference): Promise<void>;
  record_terminal(execution_id: ExecutionRequest["execution_id"], observation: ExecutorTerminalObservation): Promise<void>;
}
let projectionObserver: ExecutionProjectionObserver | null = null;
export const registerExecutionProjectionObserver = (observer: ExecutionProjectionObserver): void => { projectionObserver = observer; };

export interface ArtifactLifecycleObserver {
  find_by_id(id: ArtifactRevision["id"]): Promise<ArtifactRevision | null>;
  mark_released(id: ArtifactRevision["id"], released_at: string): Promise<ReleaseArtifactResult>;
}
let artifactLifecycleObserver: ArtifactLifecycleObserver | null = null;
export const registerArtifactLifecycleObserver = (observer: ArtifactLifecycleObserver): void => { artifactLifecycleObserver = observer; };

const loadCurrentArtifactStep = DBOS.registerStep(async (id: ArtifactRevision["id"]): Promise<ArtifactRevision | null> => {
  const artifact = await artifactLifecycleObserver?.find_by_id(id) ?? null;
  return artifact?.lifecycle.kind === "current" ? artifact : null;
}, { name: "oakridgeLoadCurrentArtifactStep", retriesAllowed: true });

const markArtifactReleasedStep = DBOS.registerStep(async (id: ArtifactRevision["id"]): Promise<ArtifactRevision | null> => {
  if (!artifactLifecycleObserver) throw new Error("artifact lifecycle observer is not registered");
  const result = await artifactLifecycleObserver.mark_released(id, new Date().toISOString());
  if (result.kind === "released" || result.kind === "already_released") return result.artifact;
  return null;
}, { name: "oakridgeMarkArtifactReleasedStep", retriesAllowed: true });

/** Exposed for the dev proof harness, which drives one adapter without a run. */
export const findExecutorAdapter = (executor_type: string): ExecutorAdapter | undefined => adapters.get(executor_type);

export const registerExecutorAdapter = (adapter: ExecutorAdapter): void => {
  if (adapters.has(adapter.executor_type)) throw new Error(`executor adapter '${adapter.executor_type}' is already registered`);
  adapters.set(adapter.executor_type, adapter);
};


interface StartExecutorInput { readonly request: ExecutionRequest; readonly attempt_id: ExecutionAttemptId }
const startExecutorStep = DBOS.registerStep(async (input: StartExecutorInput): Promise<ExternalExecutionReference> => {
  const adapter = adapters.get(input.request.executor_type);
  if (!adapter) throw new Error(`executor adapter '${input.request.executor_type}' is not registered`);
  const reference = await adapter.start_or_attach(input.request, executorOperationIdForAttempt(input.attempt_id));
  await projectionObserver?.attach_external(input.request.execution_id, reference);
  return reference;
}, { name: "oakridgeStartExecutorStep", retriesAllowed: true });

interface ObserveExecutorInput { readonly request: ExecutionRequest; readonly external_reference: ExternalExecutionReference; readonly parent_workflow_id: string }
const observeExecutorStep = DBOS.registerStep(async (input: ObserveExecutorInput): Promise<ExecutorObservationAttempt> => {
  const adapter = adapters.get(input.request.executor_type);
  if (!adapter) throw new Error(`executor adapter '${input.request.executor_type}' is not registered`);
  const attempt = await adapter.observe_terminal(input.request.execution_id, input.external_reference);
  if (attempt.kind === "terminal") await projectionObserver?.record_terminal(input.request.execution_id, attempt.observation);
  return attempt;
}, { name: "oakridgeObserveExecutorStep", retriesAllowed: true });

/** Backoff between observation polls while the executor is still running. */
const OBSERVE_POLL_INTERVAL_SECONDS = 5;

/**
 * Owns the unbounded wait for an executor to finish, as a durable loop of
 * bounded observations rather than one long-lived request. Each step is short,
 * so its retry budget covers transient network failure instead of being spent
 * on a socket the transport was always going to sever; and a backend restart
 * mid-wait simply resumes polling.
 */
const terminalObserverWorkflow = DBOS.registerWorkflow(async (input: ObserveExecutorInput): Promise<ExecutorTerminalObservation> => {
  for (;;) {
    const attempt = await observeExecutorStep(input);
    if (attempt.kind === "terminal") {
      await DBOS.send(input.parent_workflow_id, { kind: "executor_terminal", observation: attempt.observation } satisfies ExecutionWorkflowMessage, "execution-event", `terminal:${input.request.execution_id}`);
      return attempt.observation;
    }
    await DBOS.sleepSeconds(OBSERVE_POLL_INTERVAL_SECONDS);
  }
}, { name: "oakridgeTerminalObserverWorkflow" });

interface FenceExecutorInput { readonly execution_id: ExecutionRequest["execution_id"]; readonly executor_type: string; readonly external_reference: ExternalExecutionReference }
const fenceExecutorStep = DBOS.registerStep(async (input: FenceExecutorInput): Promise<void> => {
  const adapter = adapters.get(input.executor_type);
  if (!adapter) throw new Error(`executor adapter '${input.executor_type}' is not registered`);
  await adapter.cancel_or_fence(input.execution_id, input.external_reference);
}, { name: "oakridgeCancelExecutorStep", retriesAllowed: true });

export const executorFenceWorkflow = DBOS.registerWorkflow(async (input: FenceExecutorInput): Promise<void> => fenceExecutorStep(input), { name: "oakridgeExecutorFenceWorkflow" });

const deliverCollaborationInputStep = DBOS.registerStep(async (input: CollaborationPingRequest): Promise<void> => {
  const adapter = adapters.get(input.executor_type);
  if (!adapter) throw new Error(`executor adapter '${input.executor_type}' is not registered`);
  await adapter.deliver_input(input.execution_id, `collaboration:${input.thread_id}:${input.request_id}`, input.prompt, input.external_reference);
}, { name: "oakridgeDeliverCollaborationInputStep", retriesAllowed: true });

export const collaborationResponderWorkflow = DBOS.registerWorkflow(async (input: CollaborationPingRequest): Promise<void> => {
  await DBOS.setEvent("collaboration-ping-state", { kind: "delivering", thread_id: input.thread_id, request_id: input.request_id } satisfies CollaborationPingState);
  await deliverCollaborationInputStep(input);
  await DBOS.setEvent("collaboration-ping-state", { kind: "delivered", thread_id: input.thread_id, request_id: input.request_id } satisfies CollaborationPingState);
}, { name: "oakridgeCollaborationResponderWorkflow" });

interface RevisionRequestInput { readonly request: ExecutionRequest; readonly attempt_id: ExecutionAttemptId; readonly external_reference: ExternalExecutionReference; readonly delivery_key: string; readonly feedback: string }
const requestRevisionStep = DBOS.registerStep(async (input: RevisionRequestInput): Promise<void> => {
  const adapter = adapters.get(input.request.executor_type);
  if (!adapter) throw new Error(`executor adapter '${input.request.executor_type}' is not registered`);
  // Re-ensuring under this attempt's own key attaches to the session already
  // running it, rather than starting a second agent for the same work.
  const currentReference = await adapter.start_or_attach(input.request, executorOperationIdForAttempt(input.attempt_id));
  await adapter.deliver_input(input.request.execution_id, input.delivery_key, input.feedback, currentReference);
}, { name: "oakridgeRequestExecutorRevisionStep", retriesAllowed: true });

type ExecutionWorkflowMessage =
  | { readonly kind: "artifact_emitted"; readonly release: ArtifactReleaseState }
  | { readonly kind: "artifact_replaced"; readonly invalidated_artifact_id: ArtifactRevision["id"]; readonly release: ArtifactReleaseState }
  | { readonly kind: "artifact_invalidated"; readonly artifact_id: ArtifactRevision["id"]; readonly output_name: string; readonly reason: "superseded" | "withdrawn"; readonly replacement_artifact_revision_id: ArtifactRevision["id"] | null }
  | { readonly kind: "artifact_released"; readonly artifact: ArtifactReleaseState["artifact"] }
  | { readonly kind: "gate_rejected"; readonly artifact: ArtifactReleaseState["artifact"]; readonly command: Extract<GateCommand, { readonly kind: "decision" }>; readonly disposition: GateDisposition; readonly revision_target?: GateRevisionTarget }
  /** A dependency this unit already consumed has a newer revision to review. */
  | { readonly kind: "input_revised"; readonly input_name: string; readonly artifact: ArtifactEnvelope }
  | { readonly kind: "handoff_revision_requested"; readonly result: Extract<HandoffResult, { kind: "revision_requested" }> }
  | { readonly kind: "executor_terminal"; readonly observation: ExecutorTerminalObservation };

interface GateRelayInput { readonly parent_workflow_id: string; readonly request: ExecutionRequest; readonly release: Extract<ArtifactReleaseState, { kind: "waiting_gate" }> }
const gateRelayWorkflow = DBOS.registerWorkflow(async (input: GateRelayInput): Promise<GateCommand> => {
  // The waits this relay starts are addressed by the operator surface from the
  // execution side, so their IDs must be exactly what it builds. Falling back to
  // a placeholder would name a plausible-looking workflow that nothing listens
  // on, and `DBOS.send` to it still returns success.
  const relayId = DBOS.workflowID;
  if (!relayId) throw new Error("gate relay requires a workflow ID");
  let lastCommand: Extract<GateCommand, { kind: "decision" }> | null = null;
  for (const gateStep of input.release.gate_steps) {
    // The wire shape stays a list of names; the disposition is decided here,
    // where the compiled step that declared it is in hand.
    const gateInput: GateWaitInput = { stage_instance_id: input.request.stage_instance_id, execution_id: input.request.execution_id, unit_id: input.request.unit_id, artifact_revision_id: input.release.artifact.id, execution_workflow_id: input.parent_workflow_id, gate_step: gateStep.type, actions: gateStep.actions.map((action) => action.name) };
    const gate = await DBOS.startWorkflow(durableGateWorkflow, { workflowID: gateWaitWorkflowIdFromRelay(relayId, gateStep.type) })(gateInput);
    const command = await gate.getResult();
    if (command.kind !== "decision") return command;
    lastCommand = command;
    const disposition = selectGateDisposition(command.action, gateStep.actions);
    if (disposition !== "release") {
      // The revision target travels with the rejection. Without it the
      // execution can only assume the revision is its own, and an assessor
      // rejecting an assessment would be told to revise the assessment when
      // what the operator asked for was a change to the build.
      await DBOS.send(input.parent_workflow_id, { kind: "gate_rejected", artifact: input.release.artifact, command, disposition,
        revision_target: selectRevisionTarget(input.release) } satisfies ExecutionWorkflowMessage,
        "execution-event", `gate:${input.release.artifact.id}:${gateStep.type}:${command.action}`);
      return command;
    }
  }
  if (!lastCommand) throw new Error("gate release has no gate steps");
  await DBOS.send(input.parent_workflow_id, { kind: "artifact_released", artifact: input.release.artifact } satisfies ExecutionWorkflowMessage, "execution-event", `gate:${input.release.artifact.id}:released`);
  return lastCommand;
}, { name: "oakridgeGateRelayWorkflow" });

export interface ArtifactContractExecutionInput {
  readonly request: ExecutionRequest;
  readonly outputs: readonly CompiledOutputContract[];
  /**
   * Where this execution publishes its outputs' availability.
   *
   * The execution is the only participant holding both an artifact and the
   * output contract that dates its visibility, so it is the sole publisher on
   * that axis. The coordinator is not reachable by convention from here — a
   * rerun runs under an entirely different workflow ID than the unit it
   * replaces — so it is carried.
   */
  readonly coordinator_workflow_id: string;
}
export interface ArtifactContractExecutionResult { readonly external_reference: ExternalExecutionReference; readonly contract: ExecutionContractState; readonly terminal_observation: ExecutorTerminalObservation | null }

export const artifactContractExecutionWorkflow = DBOS.registerWorkflow(async (input: ArtifactContractExecutionInput): Promise<ArtifactContractExecutionResult> => {
  const workflowId = DBOS.workflowID;
  if (!workflowId) throw new Error("execution workflow requires a DBOS workflow ID");
  const attemptId = workflowId as ExecutionAttemptId;
  const externalReference = await startExecutorStep({ request: input.request, attempt_id: attemptId });
  await DBOS.startWorkflow(terminalObserverWorkflow, { workflowID: terminalObserverWorkflowId(workflowId) })({ request: input.request, external_reference: externalReference, parent_workflow_id: workflowId });
  let releases: readonly ArtifactReleaseState[] = [];
  let terminalObservation: ExecutorTerminalObservation | null = null;
  const closeReleaseWaits = async (artifactId: ArtifactRevision["id"], outputName: string, reason: "superseded" | "withdrawn", replacementId: ArtifactRevision["id"] | null): Promise<void> => {
    // Only waits this attempt opened are its to close. An artifact a previous
    // attempt released — superseded now by this attempt deriving the output
    // again — has no wait under this workflow's name, and a send to a workflow
    // that never existed is an error, not a no-op.
    const isOwned = releases.some((candidate: ArtifactReleaseState) => candidate.artifact.id === artifactId);
    releases = releases.filter((candidate: ArtifactReleaseState) => candidate.artifact.id !== artifactId);
    if (!isOwned) return;
    const gateControl: GateCommand = reason === "superseded" && replacementId
      ? { kind: "supersede", replacement_artifact_revision_id: replacementId }
      : { kind: "withdraw" };
    for (const output of input.outputs) {
      if (output.name !== outputName) continue;
      if (output.release.kind === "gate") {
        for (const step of output.release.steps) {
          await DBOS.send(gateWaitWorkflowId(workflowId, artifactId, step.type), gateControl, "gate-command", `artifact:${artifactId}:${reason}:${step.type}`);
        }
      } else if (output.release.kind === "handoff") {
        const handoffControl: HandoffCommand = reason === "superseded" && replacementId
          ? { kind: "supersede", replacement_artifact_revision_id: replacementId }
          : { kind: "withdraw" };
        await DBOS.send(handoffWorkflowId(workflowId, artifactId), handoffControl, "handoff-command", `artifact:${artifactId}:${reason}`);
      }
    }
  };
  /**
   * Publishes an artifact to the run. Called once per revision, at the moment
   * its output contract makes it visible — never twice, because the two
   * moments are mutually exclusive per output and the caller checks which one
   * applies rather than deduplicating after the fact.
   */
  const publishAvailability = async (artifact: ArtifactRevision): Promise<void> => {
    await DBOS.send(input.coordinator_workflow_id,
      { kind: "unit_output_event", event: { kind: "output_available", unit_id: input.request.unit_id, artifact } } satisfies StageSignal,
      "stage-command", `available:${artifact.id}`);
  };
  /**
   * When an output becomes visible to the run, from the contract this execution
   * was launched with. An output the stage never declared cannot be emitted —
   * `validateArtifactEmission` refuses it at the callback — so a missing
   * contract here is a broken invariant rather than a case to fall back on.
   */
  const visibilityOf = (outputName: string): OutputVisibility => {
    const output = input.outputs.find((candidate) => candidate.name === outputName);
    if (!output) throw new Error(`output '${outputName}' is not declared by this execution's contract`);
    return selectOutputVisibility(output.release);
  };

  const acceptEmission = async (release: ArtifactReleaseState): Promise<void> => {
    const currentArtifact = await loadCurrentArtifactStep(release.artifact.id);
    if (!currentArtifact) return;
    // Pending waits stay in `releases`. Contract satisfaction still counts only
    // released artifacts, but the execution has to be able to tell "parked in a
    // gate" from "never emitted" once its executor is gone.
    releases = [...withoutReleaseFor(releases, currentArtifact), release];
    if (release.kind === "waiting_gate") {
      await DBOS.startWorkflow(gateRelayWorkflow, { workflowID: gateRelayWorkflowId(workflowId, release.artifact.id) })({ parent_workflow_id: workflowId, request: input.request, release });
    } else if (release.kind === "waiting_handoff") {
      await DBOS.startWorkflow(durableHandoffWorkflow, { workflowID: handoffWorkflowId(workflowId, release.artifact.id) })({ ...release, parent_workflow_id: workflowId });
      // Visible on emission: the role that resolves this handoff is downstream,
      // so it has to hold the artifact before it can decide anything about it.
      await publishAvailability(release.artifact);
    } else {
      const released = await markArtifactReleasedStep(currentArtifact.id);
      if (released) {
        releases = withRelease(releases, released);
        await publishAvailability(released);
      }
    }
  };
  for (;;) {
    const message = await DBOS.recv<ExecutionWorkflowMessage>("execution-event", { timeoutSeconds: 86_400 });
    if (!message) continue;
    if (message.kind === "artifact_emitted") {
      await acceptEmission(message.release);
    } else if (message.kind === "artifact_replaced") {
      await closeReleaseWaits(message.invalidated_artifact_id, message.release.artifact.output_name, "superseded", message.release.artifact.id);
      await acceptEmission(message.release);
    } else if (message.kind === "artifact_invalidated") {
      await closeReleaseWaits(message.artifact_id, message.output_name, message.reason, message.replacement_artifact_revision_id);
    } else if (message.kind === "artifact_released") {
      const released = await markArtifactReleasedStep(message.artifact.id);
      if (released) {
        releases = withRelease(releases, released);
        // A gated output becomes visible here, at acceptance. A handoff's was
        // published when it was emitted — the downstream role that just
        // accepted it could not have decided otherwise — so it is not
        // republished now.
        if (visibilityOf(released.output_name) === "on_acceptance") await publishAvailability(released);
      }
    } else if (message.kind === "gate_rejected") {
      if (message.disposition === "revise") {
        // A revision aimed upstream is not this unit's work. The gate resume
        // route carries it to the unit that owns the artifact under review, and
        // this execution stays parked until that unit's revision comes back to
        // it as `input_revised`. Waking its agent here would burn a session
        // producing a document nobody asked for.
        if (message.revision_target === "upstream_handoff") continue;
        await requestRevisionStep({ request: input.request, attempt_id: attemptId, external_reference: externalReference, delivery_key: `gate:${message.artifact.id}:${message.command.gate_step}`, feedback: `Revise '${message.artifact.output_name}' after gate '${message.command.gate_step}'.` });
        continue;
      }
      return { external_reference: externalReference, contract: { kind: "waiting_artifacts", missing_outputs: [message.artifact.output_name] }, terminal_observation: { kind: "failed", code: "gate_rejected", detail: message.command.action } };
    } else if (message.kind === "input_revised") {
      // The upstream unit revised something this unit already reviewed, so its
      // own output is now stale. Asking the agent to look again is what closes
      // the loop: it emits a new revision, that supersedes the artifact parked
      // in this unit's gate, and a fresh gate opens on the new revision.
      await requestRevisionStep({ request: input.request, attempt_id: attemptId, external_reference: externalReference,
        delivery_key: `input:${message.input_name}:${message.artifact.artifact_id}`,
        feedback: `Input '${message.input_name}' has been revised. Review it again and re-emit your output.` });
      continue;
    } else if (message.kind === "handoff_revision_requested") {
      await requestRevisionStep({ request: input.request, attempt_id: attemptId, external_reference: externalReference, delivery_key: `handoff:${message.result.artifact.id}:${message.result.decision_artifact_id}`, feedback: message.result.feedback ?? "Assessment requested implementation revisions." });
      continue;
    } else {
      terminalObservation = message.observation;
      const contract = evaluateExecutionArtifactContract(releases, input.request.expected_artifacts);
      if (!shouldAwaitArtifactRelease(contract, message.observation, releases)) {
        return { external_reference: externalReference, contract, terminal_observation: message.observation };
      }
      continue;
    }
    const contract = evaluateExecutionArtifactContract(releases, input.request.expected_artifacts);
    if (contract.kind === "satisfied") {
      if (!terminalObservation) await fenceExecutorStep({ execution_id: input.request.execution_id, executor_type: input.request.executor_type, external_reference: externalReference });
      return { external_reference: externalReference, contract, terminal_observation: terminalObservation };
    }
  }
}, { name: "oakridgeArtifactContractExecutionWorkflow" });
