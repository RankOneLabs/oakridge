import type { PullRequestObservation } from "../../domain/pull-request";
import type { PullRequestBranchQuery, PullRequestReader } from "../../runtime/github-pull-requests";
import type { ProviderResult } from "../provider";

export interface PullRequestObservationInput { readonly query: PullRequestBranchQuery }
export interface PullRequestObservationResult { readonly observations: readonly PullRequestObservation[] }

/** Discovery is selected work, so its result is recorded before another action uses it. */
export class PullRequestObservationOperation {
  constructor(private readonly reader: PullRequestReader) {}

  async execute(input: PullRequestObservationInput): Promise<ProviderResult<PullRequestObservationResult>> {
    if (!this.reader.find_for_branches) return { kind: "permanently_rejected", code: "discovery_unsupported", detail: "provider has no branch discovery operation" };
    const result = await this.reader.find_for_branches(input.query);
    if (!result.ok) return { kind: "transiently_unavailable", detail: result.error.detail };
    return { kind: "acknowledged", value: { observations: result.value } };
  }
}
