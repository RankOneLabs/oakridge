import { PROVIDER_ERROR_CODES } from "../provider-catalog";
import type { PullRequestObservation } from "../../domain/pull-request";
import type { PullRequestBranchQuery, PullRequestReader } from "../../runtime/github-pull-requests";
import type { ProviderResult, ProviderCallOptions } from "../provider";

export interface PullRequestObservationInput { readonly query: PullRequestBranchQuery }
export interface PullRequestObservationResult { readonly observations: readonly PullRequestObservation[] }

/** Discovery is selected work, so its result is recorded before another action uses it. */
export class PullRequestObservationOperation {
  constructor(private readonly reader: PullRequestReader) {}

  async execute(input: PullRequestObservationInput, options: ProviderCallOptions = {}): Promise<ProviderResult<PullRequestObservationResult>> {
    if (!this.reader.find_for_branches) return { kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.discovery_unsupported, detail: "provider has no branch discovery operation" };
    const result = await this.reader.find_for_branches(input.query, options);
    if (!result.ok) return result.error.kind === "auth" ? { kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.auth, detail: result.error.detail }
      : result.error.kind === "rejected" ? { kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.provider_rejected, detail: result.error.detail }
      : { kind: "transiently_unavailable", detail: result.error.detail };
    return { kind: "acknowledged", value: { observations: result.value } };
  }
}
