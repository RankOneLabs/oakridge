import type { GitCommandRunner } from "../domain/repository-provisioning";
import { PROVIDER_ERROR_CODES } from "../effects/provider-catalog";
import type { PullRequestReader } from "../runtime/github-pull-requests";
import { isFields, type OperationCallOptions, type OperationOutcome } from "./outcome";
import { decodePullRequestObserveInput, observePullRequests } from "./pull-request-observe";
import { OPERATION_KEYS, type OperationKey } from "./registry";
import { decodeRepositoryPrepareInput, prepareRepository } from "./repository-prepare";

/** One code worker call: the operation its instruction names and the inputs step resolved for it. */
export interface OperationCall { readonly operation: string; readonly inputs: unknown }
/** Runs registered code operations. Every operation is idempotent for the same call. */
export interface OperationRunner {
  run(call: OperationCall, options?: OperationCallOptions): Promise<OperationOutcome>;
}

export interface OperationServices {
  readonly git: GitCommandRunner;
  /** Absent without a forge token: `pull_request.observe` then fails with `discovery_unsupported`. */
  readonly pull_requests: PullRequestReader | null;
}

type Implementation = (inputs: unknown, options: OperationCallOptions) => Promise<OperationOutcome>;
const invalidInput = (operation: string): OperationOutcome =>
  ({ kind: "failed", code: PROVIDER_ERROR_CODES.invalid_instruction, detail: `inputs do not match ${operation}'s input schema` });

/** The registry's implementations, one per declared key. */
export function createOperationRunner(services: OperationServices): OperationRunner {
  const implementations: { readonly [Key in OperationKey]: Implementation } = {
    [OPERATION_KEYS.repository_prepare]: async (inputs, options) => {
      const input = decodeRepositoryPrepareInput(inputs);
      return input ? prepareRepository(services.git, input, options) : invalidInput(OPERATION_KEYS.repository_prepare);
    },
    [OPERATION_KEYS.pull_request_observe]: async (inputs, options) => {
      const input = decodePullRequestObserveInput(inputs);
      return input ? observePullRequests(services.pull_requests, input, options) : invalidInput(OPERATION_KEYS.pull_request_observe);
    },
    // Step resolved the input against the workflow's type, and commit checks the output against the artifact's schema.
    [OPERATION_KEYS.value_publish]: async (inputs) => isFields(inputs) && "value" in inputs
      ? { kind: "succeeded", body: inputs.value } : invalidInput(OPERATION_KEYS.value_publish),
  };
  const isKey = (key: string): key is OperationKey => Object.hasOwn(implementations, key);
  return {
    async run(call, options = {}) {
      if (!isKey(call.operation)) return { kind: "failed", code: PROVIDER_ERROR_CODES.invalid_instruction,
        detail: `operation ${call.operation} is not registered` };
      try { return await implementations[call.operation](call.inputs, options); }
      catch (error) { return { kind: "unavailable", detail: String(error) }; }
    },
  };
}
