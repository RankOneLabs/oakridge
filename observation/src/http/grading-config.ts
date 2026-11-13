import { z } from "zod";
import type { Hono, Context } from "hono";
import { configurationDocumentSchema, configurationIssues, parseGradingDefinitions, planRegistration, selectedRunners, type GradingRegistry } from "../grading/configuration";
import type { GradingConfigStore, ConfigurationStoreError } from "../grading/configuration-store";
import type { GradingPublication, PublicationError } from "../grading/publication";
import type { RuntimeConfiguration } from "../grading/runtime-configuration";
import { requireRunnerCredentials } from "../grading/provider-credentials";
import { credentialFor, type Credentials } from "./ingest-auth";
import { errorResponse, type ErrorBody, type ErrorStatus } from "./errors";

interface ConfigurationErrorBody extends ErrorBody {
  readonly error: ErrorBody["error"] & (PublicationError | ConfigurationStoreError);
}
export interface VersionSummary { readonly version: number; readonly hash: string; readonly published_at: string; readonly definition_count: number }
export interface DamagedVersion { readonly version: number; readonly error: ConfigurationStoreError }
export interface VersionListing {
  readonly versions: readonly VersionSummary[];
  readonly damaged_versions: readonly DamagedVersion[];
  /** Includes damaged history so clients can publish with the actual latest version precondition. */
  readonly latest_version: number | null;
}
export interface GradingConfigDependencies {
  readonly store: GradingConfigStore;
  readonly publication: GradingPublication;
  readonly runtime: RuntimeConfiguration;
  readonly registry: GradingRegistry;
  readonly env: NodeJS.ProcessEnv;
}
const digestSchema = z.string().nullable();
const draftRequest = z.strictObject({ expected_draft_digest: digestSchema, document: configurationDocumentSchema });
const publishRequest = z.strictObject({ expected_draft_digest: digestSchema, expected_latest_version: z.number().int().positive().nullable() });
export function configurationFailure(c: Context, error: PublicationError | ConfigurationStoreError): Response {
  const status: ErrorStatus = error.kind === "invalid_configuration" || error.kind === "invalid_document" ? 422
    : ["draft_conflict", "version_conflict", "unconfigured_credential"].includes(error.kind) ? 409 : 500;
  const body: ConfigurationErrorBody = { error: { code: error.kind, message: error.detail, ...error } };
  return c.json(body, status);
}

export function registerGradingConfigRoutes(app: Hono, deps: GradingConfigDependencies & { readonly credentials: Credentials }): void {
  let last_failure: PublicationError | null = null;
  app.use("/v1/grading-config/*", async (c, next) => {
    if (!credentialFor(c.req.header("authorization"), deps.credentials.configure ?? []))
      return errorResponse(c, 401, "unauthorized", "configure credential required");
    await next();
  });
  app.get("/v1/grading-config/draft", async (c) => {
    const draft = await deps.store.readDraft();
    return draft.ok ? c.json(draft.value) : configurationFailure(c, draft.error);
  });
  app.put("/v1/grading-config/draft", async (c) => {
    const parsed = draftRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || parsed.data.document.status !== "draft") return errorResponse(c, 400, "invalid_request", "expected draft document and expected_draft_digest");
    const saved = await deps.store.saveDraft(parsed.data.expected_draft_digest, parsed.data.document);
    return saved.ok ? c.json(saved.value) : configurationFailure(c, saved.error);
  });
  app.post("/v1/grading-config/draft/validate", async (c) => {
    const draft = await deps.store.readDraft();
    if (!draft.ok) return configurationFailure(c, draft.error);
    const raw = draft.value?.document.definitions;
    const parsed = parseGradingDefinitions(raw, deps.registry);
    const planned = parsed.ok ? planRegistration(parsed.value, deps.registry) : parsed;
    if (!planned.ok) return configurationFailure(c, { operation: "grading_publication", kind: "invalid_configuration",
      entity_id: planned.error.entity_id, detail: planned.error.detail, issues: configurationIssues(raw, planned.error) });
    if (!parsed.ok) return errorResponse(c, 422, "invalid_configuration", "invalid draft");
    const credential = requireRunnerCredentials(selectedRunners(parsed.value), deps.env);
    if (!credential.ok) return configurationFailure(c, { ...credential.error, operation: "grading_publication", kind: "unconfigured_credential", restart_required: true });
    return c.json({ valid: true });
  });
  app.get("/v1/grading-config/versions", async (c) => {
    const listed = await deps.store.listVersions();
    if (!listed.ok) return configurationFailure(c, listed.error);
    const versions: VersionSummary[] = [];
    const damaged_versions: DamagedVersion[] = [];
    for (const version of listed.value) {
      const read = await deps.store.readVersion(version);
      if (!read.ok) damaged_versions.push({ version, error: read.error });
      else if (read.value) versions.push({ version, hash: read.value.hash, published_at: read.value.published_at, definition_count: read.value.definitions.length });
      else damaged_versions.push({ version, error: { operation: "grading_config_store", kind: "invalid_document",
        entity_id: String(version), detail: "published version disappeared", version, hash: null } });
    }
    const listing: VersionListing = { versions, damaged_versions, latest_version: listed.value.at(-1) ?? null };
    return c.json(listing);
  });
  app.get("/v1/grading-config/versions/:version", async (c) => {
    const text = c.req.param("version");
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1 || Number(text) > 999999)
      return errorResponse(c, 400, "invalid_version", "expected a positive integer version");
    const read = await deps.store.readVersion(Number(text));
    if (!read.ok) return configurationFailure(c, read.error);
    return read.value ? c.json(read.value) : errorResponse(c, 404, "not_found", "version does not exist");
  });
  app.post("/v1/grading-config/publish", async (c) => {
    const parsed = publishRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return errorResponse(c, 400, "invalid_request", "expected draft digest and latest version");
    const published = await deps.publication.publish(parsed.data);
    if (!published.ok) { last_failure = published.error; return configurationFailure(c, published.error); }
    last_failure = null;
    return c.json(published.value, published.value.outcome === "published" ? 201 : 200);
  });
  app.get("/v1/grading-config/runtime", (c) => {
    const current = deps.runtime.current();
    return c.json({ version: current.version, hash: current.hash, graders: current.grader_capability,
      applied_at: current.applied_at, last_failure });
  });
}
