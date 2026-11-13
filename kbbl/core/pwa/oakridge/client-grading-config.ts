import type { ObservationJsonValue as Json } from "./grading-contracts/domain/primitives";
import type { ObservationPublishedConfiguration } from "./grading-contracts/grading/configuration";
import type { ObservationStoredDraft } from "./grading-contracts/grading/configuration-store";
import type { ObservationPublicationOutcome } from "./grading-contracts/grading/publication";
import type { ObservationConfigurationErrorBody, ObservationGradingCatalogue, ObservationGradingRuntimeRead, ObservationPublishRequest, ObservationVersionListing } from "./grading-contracts/http/grading-config";
import { publicationFailure, publicationFeedback, type GradingFeedback } from "./lib/grading-config";

const ROOT = "/oakridge/observation/grading-config";
export type ConfigurationResult<T> = { ok: true; value: T } | { ok: false; feedback: GradingFeedback };
const transportFailure = (detail: string): ConfigurationResult<never> => ({ ok: false, feedback: { kind: "transport_error", detail } });
async function request<T>(path: string, init?: RequestInit): Promise<ConfigurationResult<T>> {
  try {
    const response = await fetch(`${ROOT}${path}`, init);
    const body = await response.json() as T | ObservationConfigurationErrorBody;
    if (response.ok) return { ok: true, value: body as T };
    const error = (body as ObservationConfigurationErrorBody | null)?.error;
    if (error && ["invalid_configuration", "draft_conflict", "version_conflict", "unconfigured_credential", "registration_failed", "persistence_failed", "runtime_apply_failed"].includes(error.kind)) {
      if (error.kind === "draft_conflict") return { ok: false, feedback: { kind: "conflict", target: "draft" } };
      if (error.operation === "grading_config_store") return transportFailure(error.detail);
      return { ok: false, feedback: publicationFailure(error) };
    }
    return transportFailure(error?.message ?? `Unexpected response (${response.status})`);
  } catch (cause) { return transportFailure(cause instanceof Error ? cause.message : "Request did not complete"); }
}
const write = (method: string, body?: Json | ObservationPublishRequest): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const readGradingDraft = (): Promise<ConfigurationResult<ObservationStoredDraft | null>> => request("/draft");
export const readGradingVersions = (): Promise<ConfigurationResult<ObservationVersionListing>> => request("/versions");
export const readGradingVersion = (version: number): Promise<ConfigurationResult<ObservationPublishedConfiguration>> => request(`/versions/${version}`);
export const readGradingCatalogue = (): Promise<ConfigurationResult<ObservationGradingCatalogue>> => request("/catalogue");
export const readGradingRuntime = (): Promise<ConfigurationResult<ObservationGradingRuntimeRead>> => request("/runtime");
export const saveGradingDraft = (definitions: readonly Json[], digest: string | null): Promise<ConfigurationResult<ObservationStoredDraft>> =>
  request("/draft", write("PUT", { document: { status: "draft", definitions }, expected_draft_digest: digest }));
export async function validateGradingDraft(): Promise<GradingFeedback> {
  const result = await request<{ readonly valid: true }>("/draft/validate", write("POST"));
  return result.ok ? (result.value?.valid === true ? { kind: "validated" } : { kind: "transport_error", detail: "Unexpected validation response" }) : result.feedback;
}
export async function publishGradingDraft(preconditions: ObservationPublishRequest): Promise<GradingFeedback> {
  const result = await request<ObservationPublicationOutcome>("/publish", write("POST", preconditions));
  if (!result.ok) return result.feedback;
  const value = result.value;
  if (!value || !["published", "unchanged", "reapplied"].includes(value.outcome) || typeof value.version !== "number" || typeof value.hash !== "string") return { kind: "transport_error", detail: "Unexpected publication response" };
  return publicationFeedback(value);
}
export interface GradingConfigurationRead {
  readonly draft: ObservationStoredDraft | null;
  readonly versions: ObservationVersionListing;
  readonly catalogue: ObservationGradingCatalogue;
  readonly runtime: ObservationGradingRuntimeRead;
  readonly latest: ObservationPublishedConfiguration | null;
  readonly selected: ObservationPublishedConfiguration | null;
}
export async function readGradingConfiguration(version: number | null): Promise<ConfigurationResult<GradingConfigurationRead>> {
  const [draft, versions, catalogue, runtime] = await Promise.all([readGradingDraft(), readGradingVersions(), readGradingCatalogue(), readGradingRuntime()]);
  if (!draft.ok) return draft;
  if (!versions.ok) return versions;
  if (!catalogue.ok) return catalogue;
  if (!runtime.ok) return runtime;
  const latestNumber = versions.value.latest_version;
  const latest = latestNumber === null ? { ok: true as const, value: null } : await readGradingVersion(latestNumber);
  // A damaged latest document must not hide the editable draft or its true concurrency token.
  const selected = version === null ? { ok: true as const, value: null } : version === latestNumber ? latest : await readGradingVersion(version);
  if (!selected.ok) return selected;
  return { ok: true, value: { draft: draft.value, versions: versions.value, catalogue: catalogue.value, runtime: runtime.value, latest: latest.ok ? latest.value : null, selected: selected.value } };
}
