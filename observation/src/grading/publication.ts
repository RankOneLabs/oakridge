import { err, ok, type Result } from "../domain/primitives";
import type { Credentials } from "../http/ingest-auth";
import type { ProducerProfile } from "../ports/producer-profile";
import type { Database, TenantScope } from "../storage/database";
import { registerDefinitions } from "../storage/grading-store";
import { configurationDocumentSchema, configurationHash, configurationIssues, parseGradingDefinitions, planRegistration, selectedRunners,
  type ConfigurationIssue, type GradingRegistration, type GradingRegistry, type PublishedConfiguration } from "./configuration";
import type { ConfigurationStoreError, GradingConfigStore, StoredDraft } from "./configuration-store";
import { requireRunnerCredentials } from "./provider-credentials";
import { RuntimeConfiguration, runtimeSnapshot } from "./runtime-configuration";

/** Every credential-reachable tenant receives the producer's registered definitions. */
export function producerTenants(credentials: Credentials, producer: string): readonly TenantScope[] {
  const all = [...credentials.ingest, ...credentials.read, ...(credentials.grade ?? [])].filter((credential) => credential.producer === producer);
  return [...new Map(all.map((credential) => [JSON.stringify([credential.producer, credential.namespace]),
    { producer: credential.producer, namespace: credential.namespace }])).values()];
}
export interface PublishRequest { readonly expected_draft_digest: string | null; readonly expected_latest_version: number | null;
  /** Offline recovery always appends history, even when restoring the latest content. */
  readonly force_new_version?: boolean }
interface PublicationMetadata {
  readonly version: number;
  readonly hash: string;
  readonly published_at: string;
}
export type PublicationOutcome = PublicationMetadata & (
  | { readonly outcome: "published" } | { readonly outcome: "unchanged" } | { readonly outcome: "reapplied" }
);
interface PublicationErrorContext { readonly operation: "grading_publication"; readonly entity_id: string; readonly detail: string }
export type PublicationError = PublicationErrorContext & (
  | { readonly kind: "invalid_configuration"; readonly issues: readonly ConfigurationIssue[] }
  | { readonly kind: "draft_conflict"; readonly current_digest: string | null }
  | { readonly kind: "version_conflict"; readonly current_latest_version: number | null }
  | { readonly kind: "unconfigured_credential"; readonly restart_required: true }
  | { readonly kind: "registration_failed" | "persistence_failed" | "runtime_apply_failed" }
);
export interface PublicationDependencies {
  readonly db: Database;
  readonly store: GradingConfigStore;
  readonly runtime: RuntimeConfiguration;
  readonly registry: GradingRegistry;
  readonly credentials: Credentials;
  readonly profile: (registration: GradingRegistration) => ProducerProfile;
  /** The running process's environment; publication never reloads an env file. */
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly register?: typeof registerDefinitions;
}
export interface GradingPublication {
  publish(request: PublishRequest): Promise<Result<PublicationOutcome, PublicationError>>;
  restoreDraft(version: number, expected_draft_digest: string | null): Promise<Result<StoredDraft, PublicationError>>;
}
const failure = (kind: "registration_failed" | "persistence_failed" | "runtime_apply_failed", entity_id: string, detail: string): Result<never, PublicationError> =>
  err({ operation: "grading_publication", kind, entity_id, detail });
const storeFailure = (error: ConfigurationStoreError): Result<never, PublicationError> => error.kind === "draft_conflict"
  ? err({ ...error, operation: "grading_publication" }) : failure("persistence_failed", error.entity_id, error.detail);
const detailOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const outcome = (kind: PublicationOutcome["outcome"], document: PublishedConfiguration): PublicationOutcome => ({
  outcome: kind, version: document.version, hash: document.hash, published_at: document.published_at,
});

/** Validate, require credentials, register, persist, then atomically apply. No historical captures are visited. */
export function createGradingPublication(deps: PublicationDependencies): GradingPublication {
  const register = async (registration: GradingRegistration, producer: string): Promise<Result<void, PublicationError>> => {
    try {
      for (const tenant of producerTenants(deps.credentials, producer)) {
        const registered = await (deps.register ?? registerDefinitions)(deps.db, tenant, registration);
        if (!registered.ok) return failure("registration_failed", registered.error.entity_id, registered.error.detail);
      }
      return ok(undefined);
    } catch (cause) { return failure("registration_failed", producer, detailOf(cause)); }
  };
  return {
    publish: (request) => deps.store.withLock(async (store) => {
      const draft = await store.readDraft();
      if (!draft.ok) return storeFailure(draft.error);
      const current_digest = draft.value?.digest ?? null;
      if (request.expected_draft_digest !== current_digest) return err({ operation: "grading_publication", kind: "draft_conflict",
        entity_id: "draft", detail: "draft changed since it was read", current_digest });
      const listed = await store.listVersions();
      if (!listed.ok) return storeFailure(listed.error);
      const current_latest_version = listed.value.at(-1) ?? null;
      if (request.expected_latest_version !== current_latest_version) return err({ operation: "grading_publication", kind: "version_conflict",
        entity_id: "versions", detail: "latest version changed since it was read", current_latest_version });
      if (!draft.value) return err({ operation: "grading_publication", kind: "invalid_configuration", entity_id: "draft",
        detail: "no draft exists", issues: [{ definition_index: null, path: [], detail: "no draft exists" }] });
      const definitions = parseGradingDefinitions(draft.value.document.definitions, deps.registry);
      if (!definitions.ok) return err({ operation: "grading_publication", kind: "invalid_configuration", entity_id: definitions.error.entity_id,
        detail: definitions.error.detail, issues: configurationIssues(draft.value.document.definitions, definitions.error) });
      const planned = planRegistration(definitions.value, deps.registry);
      if (!planned.ok) return err({ operation: "grading_publication", kind: "invalid_configuration", entity_id: planned.error.entity_id,
        detail: planned.error.detail, issues: configurationIssues(definitions.value, planned.error) });
      const hash = configurationHash(definitions.value);
      if (!hash.ok) return err({ operation: "grading_publication", kind: "invalid_configuration", entity_id: "draft", detail: hash.error.detail,
        issues: [{ definition_index: null, path: [], detail: hash.error.detail }] });
      const credentials = requireRunnerCredentials(selectedRunners(definitions.value), deps.env ?? process.env);
      if (!credentials.ok) return err({ operation: "grading_publication", kind: "unconfigured_credential", entity_id: credentials.error.entity_id,
        detail: credentials.error.detail, restart_required: true });
      // Corrupt published content blocks startup, but must not block an explicit recovery publication.
      const latest = current_latest_version === null ? ok(null) : await store.readVersion(current_latest_version);
      if (!latest.ok && latest.error.kind !== "invalid_document") return storeFailure(latest.error);
      const same = !request.force_new_version && latest.ok && latest.value?.hash === hash.value ? latest.value : null;
      if (same && deps.runtime.current().hash === hash.value) return ok(outcome("unchanged", same));
      const registration = planned.value;
      const profile = deps.profile(registration);
      const applied_at = (deps.now ?? (() => new Date().toISOString()))();
      const registered = await register(registration, profile.producer);
      if (!registered.ok) return registered;
      const document = same ? ok(same) : await store.allocateAndWritePublished({ definitions: definitions.value, published_at: applied_at });
      if (!document.ok) return storeFailure(document.error);
      try {
        deps.runtime.replace(runtimeSnapshot({ version: document.value.version, hash: document.value.hash, registration, profile, applied_at }));
      } catch (cause) { return failure("runtime_apply_failed", String(document.value.version), detailOf(cause)); }
      return ok(outcome(same ? "reapplied" : "published", document.value));
    }),
    restoreDraft: (version, expected_draft_digest) => deps.store.withLock(async (store) => {
      const document = await store.readVersion(version);
      if (!document.ok) return storeFailure(document.error);
      if (!document.value) return err({ operation: "grading_publication", kind: "invalid_configuration", entity_id: String(version),
        detail: "version does not exist", issues: [{ definition_index: null, path: ["version"], detail: "version does not exist" }] });
      // Published definitions are JSON from the same document schema; no runtime work occurs here.
      const draft = configurationDocumentSchema.safeParse({ status: "draft", definitions: document.value.definitions });
      if (!draft.success || draft.data.status !== "draft") return failure("persistence_failed", String(version), "published definitions are not JSON");
      const saved = await store.saveDraft(expected_draft_digest, draft.data);
      return saved.ok ? saved : storeFailure(saved.error);
    }),
  };
}
