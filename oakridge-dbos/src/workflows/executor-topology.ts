import { DBOS } from "@dbos-inc/dbos-sdk";

import type { ExecutionRequest, ExecutorAdapter, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import type { ArtifactReleaseState, ArtifactRevision, ExecutionContractState, ReleaseArtifactResult } from "../domain/artifacts";
import type { CompiledOutputContract } from "../domain/compiled-workflow";
import { evaluateExecutionArtifactContract, shouldAwaitArtifactRelease } from "../contracts/evaluate-artifacts";
import { durableGateWorkflow, type GateCommand, type GateWaitInput } from "./gate";
import { durableHandoffWorkflow, type HandoffCommand, type HandoffResult } from "./handoff";

export interface ExecutorMechanismResult {
  readonly external_reference: ExternalExecutionReference;
  readonly terminal_observation: ExecutorTerminalObservation;
}

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

export const registerExecutorAdapter = (adapter: ExecutorAdapter): void => {
  if (adapters.has(adapter.executor_type)) throw new Error(`executor adapter '${adapter.executor_type}' is already registered`);
  adapters.set(adapter.executor_type, adapter);
};

const runExecutorMechanismStep = DBOS.registerStep(async (request: ExecutionRequest): Promise<ExecutorMechanismResult> => {
  const adapter = adapters.get(request.executor_type);
  if (!adapter) throw new Error(`executor adapter '${request.executor_type}' is not registered`);
  const externalReference = await adapter.start_or_attach(request);
  const terminalObservation = await adapter.observe_terminal(request.execution_id);
  return { external_reference: externalReference, terminal_observation: terminalObservation };
}, { name: "oakridgeRunExecutorMechanismStep", retriesAllowed: true });

/**
 * This workflow reports executor mechanism state only. Its successful return
 * does not satisfy an Oakridge unit or StageInstance; artifact-contract
 * evaluation remains the caller's next workflow operation.
 */
export const executorBackedExecutionWorkflow = DBOS.registerWorkflow(async (request: ExecutionRequest): Promise<ExecutorMechanismResult> => {
  return runExecutorMechanismStep(request);
}, { name: "oakridgeExecutorBackedExecutionWorkflow" });

const startExecutorStep = DBOS.registerStep(async (request: ExecutionRequest): Promise<ExternalExecutionReference> => {
  const adapter = adapters.get(request.executor_type);
  if (!adapter) throw new Error(`executor adapter '${request.executor_type}' is not registered`);
  const reference = await adapter.start_or_attach(request);
  await projectionObserver?.attach_external(request.execution_id, reference);
  return reference;
}, { name: "oakridgeStartExecutorStep", retriesAllowed: true });

interface ObserveExecutorInput { readonly request: ExecutionRequest; readonly external_reference: ExternalExecutionReference; readonly parent_workflow_id: string }
const observeExecutorStep = DBOS.registerStep(async (input: ObserveExecutorInput): Promise<ExecutorTerminalObservation> => {
  const adapter = adapters.get(input.request.executor_type);
  if (!adapter) throw new Error(`executor adapter '${input.request.executor_type}' is not registered`);
  const observation = await adapter.observe_terminal(input.request.execution_id, input.external_reference);
  await projectionObserver?.record_terminal(input.request.execution_id, observation);
  return observation;
}, { name: "oakridgeObserveExecutorStep", retriesAllowed: true });

const terminalObserverWorkflow = DBOS.registerWorkflow(async (input: ObserveExecutorInput): Promise<ExecutorTerminalObservation> => {
  const observation = await observeExecutorStep(input);
  await DBOS.send(input.parent_workflow_id, { kind: "executor_terminal", observation } satisfies ExecutionWorkflowMessage, "execution-event", `terminal:${input.request.execution_id}`);
  return observation;
}, { name: "oakridgeTerminalObserverWorkflow" });

interface FenceExecutorInput { readonly execution_id: ExecutionRequest["execution_id"]; readonly executor_type: string; readonly external_reference?: ExternalExecutionReference }
const fenceExecutorStep = DBOS.registerStep(async (input: FenceExecutorInput): Promise<void> => {
  const adapter = adapters.get(input.executor_type);
  if (!adapter) throw new Error(`executor adapter '${input.executor_type}' is not registered`);
  await adapter.cancel_or_fence(input.execution_id, input.external_reference);
}, { name: "oakridgeCancelExecutorStep", retriesAllowed: true });

export const executorFenceWorkflow = DBOS.registerWorkflow(async (input: FenceExecutorInput): Promise<void> => fenceExecutorStep(input), { name: "oakridgeExecutorFenceWorkflow" });

interface RevisionRequestInput { readonly request: ExecutionRequest; readonly external_reference: ExternalExecutionReference; readonly delivery_key: string; readonly feedback: string }
const requestRevisionStep = DBOS.registerStep(async (input: RevisionRequestInput): Promise<void> => {
  const adapter = adapters.get(input.request.executor_type);
  if (!adapter) throw new Error(`executor adapter '${input.request.executor_type}' is not registered`);
  const currentReference = await adapter.start_or_attach(input.request);
  await adapter.request_revision(input.request.execution_id, input.delivery_key, input.feedback, currentReference);
}, { name: "oakridgeRequestExecutorRevisionStep", retriesAllowed: true });

type ExecutionWorkflowMessage =
  | { readonly kind: "artifact_emitted"; readonly release: ArtifactReleaseState }
  | { readonly kind: "artifact_replaced"; readonly invalidated_artifact_id: ArtifactRevision["id"]; readonly release: ArtifactReleaseState }
  | { readonly kind: "artifact_invalidated"; readonly artifact_id: ArtifactRevision["id"]; readonly output_name: string; readonly reason: "superseded" | "withdrawn"; readonly replacement_artifact_revision_id: ArtifactRevision["id"] | null }
  | { readonly kind: "artifact_released"; readonly artifact: ArtifactReleaseState["artifact"] }
  | { readonly kind: "gate_rejected"; readonly artifact: ArtifactReleaseState["artifact"]; readonly command: Extract<GateCommand, { readonly kind: "decision" }> }
  | { readonly kind: "handoff_revision_requested"; readonly result: Extract<HandoffResult, { kind: "revision_requested" }> }
  | { readonly kind: "executor_terminal"; readonly observation: ExecutorTerminalObservation };

interface GateRelayInput { readonly parent_workflow_id: string; readonly request: ExecutionRequest; readonly release: Extract<ArtifactReleaseState, { kind: "waiting_gate" }> }
const gateRelayWorkflow = DBOS.registerWorkflow(async (input: GateRelayInput): Promise<GateCommand> => {
  let lastCommand: Extract<GateCommand, { kind: "decision" }> | null = null;
  for (const gateStep of input.release.gate_steps) {
    const gateInput: GateWaitInput = { stage_instance_id: input.request.stage_instance_id, execution_id: input.request.execution_id, unit_id: input.request.unit_id, artifact_revision_id: input.release.artifact.id, gate_step: gateStep.type, actions: gateStep.actions };
    const gate = await DBOS.startWorkflow(durableGateWorkflow, { workflowID: `${DBOS.workflowID}:wait:${gateStep.type}` })(gateInput);
    const command = await gate.getResult();
    if (command.kind !== "decision") return command;
    lastCommand = command;
    const isPass = command.action === "pass" || command.action === "approve" || command.action === "confirm_merged" || command.action === "closed_without_merge";
    if (!isPass) {
      await DBOS.send(input.parent_workflow_id, { kind: "gate_rejected", artifact: input.release.artifact, command } satisfies ExecutionWorkflowMessage, "execution-event", `gate:${input.release.artifact.id}:${gateStep.type}:${command.action}`);
      return command;
    }
  }
  if (!lastCommand) throw new Error("gate release has no gate steps");
  await DBOS.send(input.parent_workflow_id, { kind: "artifact_released", artifact: input.release.artifact } satisfies ExecutionWorkflowMessage, "execution-event", `gate:${input.release.artifact.id}:released`);
  return lastCommand;
}, { name: "oakridgeGateRelayWorkflow" });

export interface ArtifactContractExecutionInput { readonly request: ExecutionRequest; readonly outputs: readonly CompiledOutputContract[] }
export interface ArtifactContractExecutionResult { readonly external_reference: ExternalExecutionReference; readonly contract: ExecutionContractState; readonly terminal_observation: ExecutorTerminalObservation | null }

export const artifactContractExecutionWorkflow = DBOS.registerWorkflow(async (input: ArtifactContractExecutionInput): Promise<ArtifactContractExecutionResult> => {
  const workflowId = DBOS.workflowID;
  if (!workflowId) throw new Error("execution workflow requires a DBOS workflow ID");
  const externalReference = await startExecutorStep(input.request);
  await DBOS.startWorkflow(terminalObserverWorkflow, { workflowID: `${workflowId}:terminal` })({ request: input.request, external_reference: externalReference, parent_workflow_id: workflowId });
  let releases: ArtifactReleaseState[] = [];
  let terminalObservation: ExecutorTerminalObservation | null = null;
  const closeReleaseWaits = async (artifactId: ArtifactRevision["id"], outputName: string, reason: "superseded" | "withdrawn", replacementId: ArtifactRevision["id"] | null): Promise<void> => {
    releases = releases.filter((candidate) => candidate.artifact.id !== artifactId);
    const gateControl: GateCommand = reason === "superseded" && replacementId
      ? { kind: "supersede", replacement_artifact_revision_id: replacementId }
      : { kind: "withdraw" };
    for (const output of input.outputs) {
      if (output.name !== outputName) continue;
      if (output.release.kind === "gate") {
        for (const step of output.release.steps) {
          await DBOS.send(`${workflowId}:gate:${artifactId}:wait:${step.type}`, gateControl, "gate-command", `artifact:${artifactId}:${reason}:${step.type}`);
        }
      } else if (output.release.kind === "handoff") {
        const handoffControl: HandoffCommand = reason === "superseded" && replacementId
          ? { kind: "supersede", replacement_artifact_revision_id: replacementId }
          : { kind: "withdraw" };
        await DBOS.send(`${workflowId}:handoff:${artifactId}`, handoffControl, "handoff-command", `artifact:${artifactId}:${reason}`);
      }
    }
  };
  const acceptEmission = async (release: ArtifactReleaseState): Promise<void> => {
    const currentArtifact = await loadCurrentArtifactStep(release.artifact.id);
    if (!currentArtifact) return;
    releases = releases.filter((candidate) => candidate.artifact.output_name !== currentArtifact.output_name);
    if (release.kind === "waiting_gate") {
      await DBOS.startWorkflow(gateRelayWorkflow, { workflowID: `${workflowId}:gate:${release.artifact.id}` })({ parent_workflow_id: workflowId, request: input.request, release });
    } else if (release.kind === "waiting_handoff") {
      await DBOS.startWorkflow(durableHandoffWorkflow, { workflowID: `${workflowId}:handoff:${release.artifact.id}` })({ ...release, parent_workflow_id: workflowId });
    } else {
      const released = await markArtifactReleasedStep(currentArtifact.id);
      if (released) releases.push({ kind: "released", artifact: released });
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
      if (released) releases.push({ kind: "released", artifact: released });
    } else if (message.kind === "gate_rejected") {
      if (message.command.action === "rerun" || message.command.action === "request_revision") {
        await requestRevisionStep({ request: input.request, external_reference: externalReference, delivery_key: `gate:${message.artifact.id}:${message.command.gate_step}`, feedback: `Revise '${message.artifact.output_name}' after gate '${message.command.gate_step}'.` });
        continue;
      }
      return { external_reference: externalReference, contract: { kind: "waiting_artifacts", missing_outputs: [message.artifact.output_name] }, terminal_observation: { kind: "failed", code: "gate_rejected", detail: message.command.action } };
    } else if (message.kind === "handoff_revision_requested") {
      await requestRevisionStep({ request: input.request, external_reference: externalReference, delivery_key: `handoff:${message.result.artifact.id}:${message.result.decision_artifact_id}`, feedback: message.result.feedback ?? "Assessment requested implementation revisions." });
      continue;
    } else {
      terminalObservation = message.observation;
      const contract = evaluateExecutionArtifactContract(input.outputs, releases, input.request.expected_artifacts);
      if (!shouldAwaitArtifactRelease(contract, message.observation)) {
        return { external_reference: externalReference, contract, terminal_observation: message.observation };
      }
      continue;
    }
    const contract = evaluateExecutionArtifactContract(input.outputs, releases, input.request.expected_artifacts);
    if (contract.kind === "satisfied") {
      if (!terminalObservation) await fenceExecutorStep({ execution_id: input.request.execution_id, executor_type: input.request.executor_type, external_reference: externalReference });
      return { external_reference: externalReference, contract, terminal_observation: terminalObservation };
    }
  }
}, { name: "oakridgeArtifactContractExecutionWorkflow" });
