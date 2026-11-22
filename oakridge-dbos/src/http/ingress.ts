import { parseExecutionEvidence, type ExecutionReconciliation, type KeyedExecutionRecovery } from "../domain/keyed-execution";
import type { AssessmentDecisionReceipt } from "../storage/json-column-types";
import type { AssessmentDecisionCommand, Citation, DispatchAuthorizationRequest, FeedbackItemRequest } from "../core-client/core-types";
import { readPinnedDefinition } from "../storage/read-store";
import { declarationDigest } from "../adapters/observation-schema-version";
import { parsePrIntegration, type PrIntegration } from "../domain/pr-integration";
import { preflightLaunch, isPrDependent, type PrIntegrationHealth } from "../runtime/pr-launch-preflight";
import { readSkillIndex, resolveLaunchableDefinition, type DefinitionId } from "../runtime/definition-store";
import type { Context, Hono } from "hono";
import { createHash } from "node:crypto";
import type { Event, Writer } from "../core-client/core-types";
import { acceptsAnalysisLinkDeclarations, selectApplicableEntries, type AnalysisLinkEntry } from "../domain/analysis-link-declaration";
import { err, ok, type ProjectId, type Result, type RunId } from "../domain/primitives";
import { parseRunConfig, type RunConfig } from "../domain/run-config";
import { commitAnalysisLinkDeclaration, commitAssessmentMutation, commitDecisionWithLinks, commitEvent, commitExecutionMutation, launchRunId, replayLaunch, type LaunchRequestContent, type CommitDependencies, type CommitOutcome, type CommitRequest, type CommitResult } from "../storage/commit";
import { readSessionAttempt } from "../storage/read-store";
import { hasProject } from "../storage/operator-store";
import { operatorWriterFromCredential } from "./control-auth";
import { ConflictError, errorResponse, fault, MalformedRequestError, MissingEntityError, requestBody, UnauthorizedError } from "./errors";

/**
 * Ingress (part 1 §7.1): HTTP to events. Each route checks authentication and
 * request shape, resolves the writer from the credential presented, and makes
 * exactly one commit call; everything else is decided in `step`. A writer, or
 * a `by`, in a request body is never read.
 */

/** Every ingress request carries the id that makes it idempotent. */
export interface IngressRequest { readonly request_id: string }
export interface LaunchRequest extends IngressRequest {
  readonly pr_integration?: PrIntegration;
  readonly definition_id: DefinitionId; readonly input: unknown; readonly project_id?: string | null;
  /** Session settings keyed by stage, then by agent worker, and the run's automatic-grading choice. */
  readonly config?: Pick<RunConfig, "sessions" | "grading_enabled"> | null;
}
export interface DecideRequest extends IngressRequest {
  readonly decision: string; readonly target: string; readonly payload: unknown;
  /** Optional explicit links, declared against the tasks revision this decision approves. Nothing requires them. */
  readonly analysis_links?: readonly AnalysisLinkEntry[];
}
/** What an agent sends to publish a revision; its attempt comes from the session secret. */
export type DecideAssessmentRequest = IngressRequest & AssessmentDecisionCommand;
export type AuthorizeFeedbackRequest = IngressRequest & DispatchAuthorizationRequest;
export type CreateFeedbackRequest = IngressRequest & FeedbackItemRequest;
export interface AuthorizationResponse { readonly authorization_id: string }
export interface CreateFeedbackResponse { readonly item_id: string }
export interface PublishRequest extends IngressRequest { readonly body: unknown; readonly predecessor: string | null; readonly subject: string | null }
/** Explicit producer-supplied links against one exact approved tasks revision. */
export interface DeclareLinksRequest extends IngressRequest { readonly tasks_revision_id: string; readonly entries: readonly AnalysisLinkEntry[] }
/** Nothing applicable was supplied, so nothing was journaled: missing links are valid and need no one's action. */
export interface NoDeclaration { readonly kind: "no_declaration"; readonly run_id: string }
/** Successful ingress returns the committed event; typed refusals use the shared error response. */
export type IngressResponse = IngressCommitted;
/** A committed (or replayed) ingress request: the only success body. */
export interface IngressCommitted { readonly kind: "committed"; readonly run_id: string; readonly event_id: string; readonly analysis_links?: DeclaredLinks; readonly assessment_decision?: AssessmentDecisionReceipt }
/** What a decision's supplied links came to. A refusal refuses only them: the decision stands. */
export type DeclaredLinks = { readonly kind: "committed"; readonly event_id: string } | { readonly kind: "refused"; readonly reason: string };

type Fields = { readonly [key: string]: unknown };
const isFields = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);
const isRequestId = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 200;
const isKey = (value: unknown): value is string => typeof value === "string" && value.length >= 1;
const isOptionalId = (value: unknown): value is string | null | undefined => value === undefined || value === null || isKey(value);

type Parsed<Value> = Result<Value, MalformedRequestError>;
const malformed = (detail: string): Parsed<never> => err(new MalformedRequestError(detail));

export function parseIngressRequest(raw: unknown): Parsed<IngressRequest> {
  return isFields(raw) && isRequestId(raw.request_id) ? ok({ request_id: raw.request_id }) : malformed("request_id (1 to 200 characters) is required");
}
export function parseLaunchRequest(raw: unknown): Parsed<LaunchRequest> {
  if (!isFields(raw) || !isRequestId(raw.request_id) || typeof raw.definition_id !== "string" || !/^[0-9a-f]{64}$/.test(raw.definition_id) || !("input" in raw) || !isOptionalId(raw.project_id))
    return malformed("request_id (1 to 200 characters), definition_id and input are required");
  if ((raw.pr_integration !== undefined && parsePrIntegration(raw.pr_integration) === null)
    || (isFields(raw.config) && ("pr_integration" in raw.config || "pr_skill_digest" in raw.config)))
    return malformed("pr_integration is gated-review, github-cli or none; config may not set pr_integration or pr_skill_digest");
  const config = raw.config === undefined || raw.config === null ? null : parseRunConfig(raw.config);
  if (raw.config !== undefined && raw.config !== null && config === null)
    return malformed("config.sessions maps each stage and worker to { harness, model, effort }; config.grading_enabled is a boolean");
  return ok({ request_id: raw.request_id, definition_id: raw.definition_id as DefinitionId, input: raw.input, ...(raw.pr_integration === undefined ? {} : { pr_integration: parsePrIntegration(raw.pr_integration)! }), project_id: raw.project_id ?? null, config: config ? { sessions: config.sessions, grading_enabled: config.grading_enabled } : null });
}
const isTaskIds = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(isKey);
const isLinkEntry = (value: unknown): value is AnalysisLinkEntry =>
  isFields(value) && isKey(value.source_revision_id) && isKey(value.item_path) && isTaskIds(value.task_ids);
const linkEntry = ({ source_revision_id, item_path, task_ids }: AnalysisLinkEntry): AnalysisLinkEntry => ({ source_revision_id, item_path, task_ids });
export function parseDecideRequest(raw: unknown): Parsed<DecideRequest> {
  if (!isFields(raw) || !isRequestId(raw.request_id) || !isKey(raw.decision) || !isKey(raw.target) || !("payload" in raw))
    return malformed("request_id, decision, target and payload are required");
  if (raw.analysis_links !== undefined && !(Array.isArray(raw.analysis_links) && raw.analysis_links.every(isLinkEntry)))
    return malformed("analysis_links is a list of { source_revision_id, item_path, task_ids }");
  return ok({ request_id: raw.request_id, decision: raw.decision, target: raw.target, payload: raw.payload,
    ...(raw.analysis_links ? { analysis_links: raw.analysis_links.map(linkEntry) } : {}) });
}
export function parsePublishRequest(raw: unknown): Parsed<PublishRequest> {
  if (!isFields(raw) || !isRequestId(raw.request_id) || !("body" in raw) || !isOptionalId(raw.predecessor) || !isOptionalId(raw.subject))
    return malformed("request_id and body are required; predecessor and subject are revision ids or null");
  return ok({ request_id: raw.request_id, body: raw.body, predecessor: raw.predecessor ?? null, subject: raw.subject ?? null });
}

export function parseDeclareLinksRequest(raw: unknown): Parsed<DeclareLinksRequest> {
  if (!isFields(raw) || !isRequestId(raw.request_id) || !isKey(raw.tasks_revision_id) || !Array.isArray(raw.entries) || !raw.entries.every(isLinkEntry))
    return malformed("request_id, tasks_revision_id and entries of { source_revision_id, item_path, task_ids } are required");
  return ok({ request_id: raw.request_id, tasks_revision_id: raw.tasks_revision_id, entries: raw.entries.map(linkEntry) });
}

/** One commit outcome as an HTTP response: a step rejection is 409, as is a reused ingress id. */
export function ingressResponse(run_id: string, result: CommitResult): Response {
  if (!result.ok) return fault(`${result.error.operation} ${result.error.entity_id}: ${result.error.detail}`);
  const outcome: CommitOutcome = result.value;
  const json = (body: IngressResponse, status = 200) => Response.json(body, { status });
  switch (outcome.kind) {
    case "committed": return json({ kind: "committed", run_id, event_id: outcome.event_id, ...(outcome.assessment_decision ? { assessment_decision: outcome.assessment_decision } : {}) }, 201);
    case "replayed": return outcome.receipt.kind === "committed" ? json({ kind: "committed", run_id, event_id: outcome.receipt.event_id, ...(outcome.receipt.assessment_decision ? { assessment_decision: outcome.receipt.assessment_decision } : {}) })
      : errorResponse(new ConflictError(outcome.receipt.reason));
    case "rejected": return errorResponse(new ConflictError(outcome.reason));
    case "conflict": case "contended": return errorResponse(new ConflictError(outcome.detail));
    case "missing": return errorResponse(new MissingEntityError(outcome.detail));
  }
}

function isCitation(value: unknown): value is Citation | null | undefined {
  return value == null || (isFields(value) && isKey(value.revision_id) && typeof value.pointer === "string" && Object.keys(value).length === 2);
}

function assessmentMutationResponse(run: string, result: CommitResult, field: "item_id" | "authorization_id"): Response {
  if (result.ok && result.value.kind === "committed") return Response.json({ [field]: result.value.event_id }, { status: 201 });
  if (result.ok && result.value.kind === "replayed" && result.value.receipt.kind === "committed") {
    return Response.json({ [field]: result.value.receipt.event_id });
  }
  return ingressResponse(run, result);
}

function declaredLinks(outcome: CommitOutcome): DeclaredLinks {
  switch (outcome.kind) {
    case "committed": return { kind: "committed", event_id: outcome.event_id };
    case "replayed": return outcome.receipt.kind === "committed" ? { kind: "committed", event_id: outcome.receipt.event_id } : { kind: "refused", reason: outcome.receipt.reason };
    case "rejected": return { kind: "refused", reason: outcome.reason };
    case "conflict": case "contended": return { kind: "refused", reason: outcome.detail };
    case "missing": return { kind: "refused", reason: outcome.detail };
  }
}

function param(c: Context, key: string): string {
  const value = c.req.param(key);
  if (!value) throw new Error(`missing route parameter ${key}`);
  return value;
}

/** The session secret, as `Authorization: Bearer <secret>`, by its sha256 hex: the form the attempt stores. */
export function publicationSecretHash(request: Pick<Request, "headers">): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length === 7) return null;
  return createHash("sha256").update(authorization.slice(7)).digest("hex");
}
/** The writer of a publication and the attempt it names; an operator's edit names none. */
interface Publisher { readonly writer: Writer; readonly by: string | null }
const refusedSecret = (): Response => errorResponse(new UnauthorizedError("publication secret refused"));

export interface PrLaunchDependencies {
  readonly pr_integration_default?: PrIntegration;
  readonly probe_pr_integration?: (integration: PrIntegration) => Promise<PrIntegrationHealth>;
}
export interface IngressDependencies extends CommitDependencies, PrLaunchDependencies {
  readonly keyed_execution_recovery?: KeyedExecutionRecovery;
  /** Whether a request on the publish route carries the operator's credential (see `operatorCredentialCheck`). */
  readonly is_operator_request: (request: Request) => boolean;
}

export function installIngress(app: Hono, deps: IngressDependencies): void {
  const commit = (request: CommitRequest) => commitEvent(deps, request);

  app.post("/api/runs", async (c) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    const parsed = parseLaunchRequest(raw);
    if (!parsed.ok) return errorResponse(parsed.error);
    const request = parsed.value;
    try {
      const run_id = launchRunId(request.request_id);
      const writer = operatorWriterFromCredential(c.req.raw);
      const event = { kind: "launched" as const, input: request.input };
      const project_id = request.project_id ? request.project_id as ProjectId : null;
      const launch_request: LaunchRequestContent = { definition_id: request.definition_id, project_id, config: request.config ?? null,
        ...(request.pr_integration === undefined ? {} : { pr_integration: request.pr_integration }) };
      const replay = await replayLaunch(deps.db, { run_id, ingress_id: request.request_id, writer, event, launch_request });
      if (replay) return ingressResponse(run_id, replay);
      const resolved = resolveLaunchableDefinition(request.definition_id);
      if (!resolved.ok) return Response.json(resolved.error, { status: resolved.error.kind === "definition_not_launchable" ? 404 : 422 });
      const integration = request.pr_integration ?? deps.pr_integration_default ?? "none";
      const health = isPrDependent(resolved.value.source) && integration !== "none"
        ? await deps.probe_pr_integration?.(integration) ?? { kind: "unconfigured" as const, detail: "PR integration health probe is not configured" }
        : { kind: "healthy" as const };
      const preflight = preflightLaunch({ definition: resolved.value, integration, health });
      if (!preflight.ok) return Response.json(preflight.error, { status: 422 });
      const index = integration === "none" ? null : readSkillIndex();
      if (index && !index.ok) return Response.json(index.error, { status: 422 });
      const config: RunConfig = { ...parseRunConfig({})!, ...request.config, pr_integration: integration,
        pr_skill_digest: index?.ok && integration !== "none" ? index.value[integration] : null };
      const definition_id = resolved.value.definition_id;
      if (project_id && !await hasProject(deps.db, project_id)) return errorResponse(new MissingEntityError("project not found"));
      return ingressResponse(run_id, await commit({ run_id, ingress_id: request.request_id, event, writer, launch_request,
        launch: { definition_id, project_id, config } }));
    } catch (cause) { return fault(cause); }
  });

  /** An operator event on a run: its body is parsed by `parse`, and the writer is the credential. */
  const operatorEvent = <Body extends IngressRequest>(parse: (raw: unknown) => Parsed<Body>, event: (c: Context, body: Body) => Event) => async (c: Context) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    const parsed = parse(raw);
    if (!parsed.ok) return errorResponse(parsed.error);
    const run_id = param(c, "run_id") as RunId;
    try {
      return ingressResponse(run_id, await commit({ run_id, ingress_id: parsed.value.request_id,
        event: event(c, parsed.value), writer: operatorWriterFromCredential(c.req.raw) }));
    } catch (cause) { return fault(cause); }
  };
  app.post("/api/runs/:run_id/cancel", operatorEvent(parseIngressRequest, () => ({ kind: "cancel_requested" })));
  app.post("/api/runs/:run_id/units/:unit_id/workers/:worker/retry", operatorEvent(parseIngressRequest, (c) =>
    ({ kind: "retry_requested", unit: param(c, "unit_id"), worker: param(c, "worker") })));
  const analysisLinksRefused = async (run_id: string): Promise<boolean> => {
    const definition = await readPinnedDefinition(deps.db, run_id);
    if (!definition) return false; // The commit path reports the missing run.
    const tasks = Object.values(definition.checked_program.workflow.stages)
      .flatMap((stage) => stage.artifacts.tasks ? [stage.artifacts.tasks] : []);
    return !acceptsAnalysisLinkDeclarations(tasks[0] ? declarationDigest(tasks[0].schema) : null);
  };
  /** A decision, and any links supplied with it. Supplying none is the ordinary case and journals nothing. */
  app.post("/api/runs/:run_id/units/:unit_id/reviews/:review/decide", async (c) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    if (!isFields(raw) || !isRequestId(raw.request_id) || !isKey(raw.decision) || !isKey(raw.target)) {
      return errorResponse(new MalformedRequestError("request_id, decision and target are required"));
    }
    const parsed = parseDecideRequest(raw);
    const isAssessmentRequest = Object.keys(raw).some(key => !["request_id", "decision", "target", "payload", "analysis_links"].includes(key));
    if (!parsed.ok && !isAssessmentRequest) return errorResponse(parsed.error);
    const body = parsed.ok ? parsed.value : { request_id: raw.request_id, decision: raw.decision, target: raw.target, payload: {} };
    const run_id = param(c, "run_id") as RunId;
    const request = { run_id, ingress_id: body.request_id, writer: operatorWriterFromCredential(c.req.raw),
      assessment_decision: raw, event: { kind: "operator_decided" as const, unit: param(c, "unit_id"),
      review: param(c, "review"), decision: body.decision, target: body.target, payload: body.payload } };
    const entries = selectApplicableEntries(body.analysis_links ?? []);
    try {
      if (body.analysis_links !== undefined && await analysisLinksRefused(run_id))
        return errorResponse(new MalformedRequestError("analysis_links are not accepted for current-contract runs"));
      if (entries.length === 0) return ingressResponse(run_id, await commit(request));
      const { decision, links } = await commitDecisionWithLinks(deps, request, entries);
      const response = ingressResponse(run_id, decision);
      return response.ok && links ? Response.json({ ...await response.json() as IngressCommitted, analysis_links: declaredLinks(links) } satisfies IngressCommitted, { status: response.status }) : response;
    } catch (cause) { return fault(cause); }
  });

  app.post("/api/runs/:run_id/units/:unit_id/assessments/:artifact/feedback", async (c) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    if (!isFields(raw) || !isRequestId(raw.request_id) || !isKey(raw.instruction) || !isCitation(raw.citation)) {
      return errorResponse(new MalformedRequestError("request_id, instruction and optional citation are required"));
    }
    const run_id = param(c, "run_id") as RunId;
    const result = await commitAssessmentMutation(deps, { run_id, unit: param(c, "unit_id"), request_id: raw.request_id,
      writer: operatorWriterFromCredential(c.req.raw), mutation: { kind: "feedback", artifact: param(c, "artifact"),
        command: { instruction: raw.instruction, citation: raw.citation } } });
    return assessmentMutationResponse(run_id, result, "item_id");
  });

  app.post("/api/runs/:run_id/units/:unit_id/feedback/:item_id/authorizations", async (c) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    const item = param(c, "item_id");
    if (!isFields(raw) || raw.item !== item || !isRequestId(raw.request_id) || !isKey(raw.target_revision)
        || !isKey(raw.instruction) || !Array.isArray(raw.recipients) || !raw.recipients.every(isKey)) {
      return errorResponse(new MalformedRequestError("request_id, matching item, target_revision, instruction and recipients are required"));
    }
    const run_id = param(c, "run_id") as RunId;
    const result = await commitAssessmentMutation(deps, { run_id, unit: param(c, "unit_id"), request_id: raw.request_id,
      writer: operatorWriterFromCredential(c.req.raw), mutation: { kind: "authorization",
        command: { item, target_revision: raw.target_revision, instruction: raw.instruction, recipients: raw.recipients } } });
    return assessmentMutationResponse(run_id, result, "authorization_id");
  });

  /**
   * The writer of explicit analysis links, for a caller holding producer-supplied associations
   * after a tasks approval. It is separate from the decision: the approval commits on its own and
   * maps to nothing, and only what a caller supplies here can ever become a link.
   */
  app.post("/api/runs/:run_id/analysis-links", async (c) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    const parsed = parseDeclareLinksRequest(raw);
    if (!parsed.ok) return errorResponse(parsed.error);
    const run_id = param(c, "run_id") as RunId;
    const { request_id, tasks_revision_id } = parsed.value;
    const entries = selectApplicableEntries(parsed.value.entries);
    try {
      if (await analysisLinksRefused(run_id))
        return errorResponse(new MalformedRequestError("analysis_links are not accepted for current-contract runs"));
      if (entries.length === 0) return Response.json({ kind: "no_declaration", run_id } satisfies NoDeclaration);
      return ingressResponse(run_id, await commitAnalysisLinkDeclaration(deps.db, { ingress_id: request_id,
        declaration: { run_id, tasks_revision_id, entries }, writer: operatorWriterFromCredential(c.req.raw) }));
    } catch (cause) { return fault(cause); }
  });

  async function handleExecution(c: Context, operation: "claim" | "evidence" | "reconcile"): Promise<Response> {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    if (!isFields(raw) || !isRequestId(raw.request_id)) return errorResponse(new MalformedRequestError("request_id is required"));
    const run_id = param(c, "run_id");
    const unit_id = param(c, "unit_id");
    const scope = { run_id, unit_id, key: param(c, "key"), request_id: raw.request_id };
    try {
      if (operation === "reconcile") {
        if (!deps.is_operator_request(c.req.raw)) return errorResponse(new UnauthorizedError("operator credential refused"));
        const outcome = parseExecutionReconciliation(raw.outcome);
        if (!outcome) return errorResponse(new MalformedRequestError("outcome must supply evidence or never_accepted"));
        return executionResponse(await commitExecutionMutation(deps, { ...scope, mutation: { kind: "reconcile", outcome } },
          operatorWriterFromCredential(c.req.raw)));
      }
      const publisher = await resolvePublisher(c.req.raw, { run_id: run_id as RunId, unit: unit_id });
      if (!publisher?.by || publisher.writer.kind !== "session") return refusedSecret();
      if (operation === "claim") return executionResponse(await commitExecutionMutation(deps, { ...scope,
        mutation: { kind: "claim", recovery: deps.keyed_execution_recovery ?? "off", action_id: publisher.by } }, publisher.writer));
      const evidence = parseExecutionEvidence(raw.evidence);
      if (!evidence) return errorResponse(new MalformedRequestError("evidence requires external_id, store_path and detail"));
      return executionResponse(await commitExecutionMutation(deps, { ...scope,
        mutation: { kind: "evidence", evidence, action_id: publisher.by } }, publisher.writer));
    } catch (cause) { return fault(cause); }
  }

  app.post("/api/runs/:run_id/units/:unit_id/executions/:key/claim", (c) => handleExecution(c, "claim"));
  app.put("/api/runs/:run_id/units/:unit_id/executions/:key/evidence", (c) => handleExecution(c, "evidence"));
  app.post("/api/runs/:run_id/units/:unit_id/executions/:key/reconciliation", (c) => handleExecution(c, "reconcile"));

  /**
   * Publish. A session secret names the running attempt, which is both the
   * writer's attempt and the revision's `by`. Failing that, the operator's
   * credential makes it an operator's edit (D2): `Writer::Operator`, no `by`.
   */
  app.put("/api/runs/:run_id/units/:unit_id/artifacts/:artifact", async (c) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    const parsed = parsePublishRequest(raw);
    if (!parsed.ok) return errorResponse(parsed.error);
    const run_id = param(c, "run_id") as RunId, unit = param(c, "unit_id");
    try {
      const publisher = await resolvePublisher(c.req.raw, { run_id, unit });
      if (!publisher) return refusedSecret();
      const request = parsed.value;
      return ingressResponse(run_id, await commit({ run_id, ingress_id: request.request_id,
        event: { kind: "revision_published", unit, artifact: param(c, "artifact"), body: request.body,
          predecessor: request.predecessor, subject: request.subject, by: publisher.by },
        writer: publisher.writer }));
    } catch (cause) { return fault(cause); }
  });

  /** Who publishes: the session whose secret is presented, else the operator, else no one. */
  async function resolvePublisher(request: Request, scope: { readonly run_id: RunId; readonly unit: string }): Promise<Publisher | null> {
    const secret_hash = publicationSecretHash(request);
    const attempt = secret_hash ? await readSessionAttempt(deps.db, { run_id: scope.run_id, unit_id: scope.unit, secret_hash }) : null;
    if (attempt) return attempt.unit_id === scope.unit
      ? { writer: { kind: "session", session: attempt.kbbl_session_id, attempt: attempt.action_id }, by: attempt.action_id } : null;
    return deps.is_operator_request(request) ? { writer: operatorWriterFromCredential(request), by: null } : null;
  }
}


function parseExecutionReconciliation(raw: unknown): ExecutionReconciliation | null {
  if (!isFields(raw)) return null;
  if (raw.kind === "never_accepted") return { kind: raw.kind };
  if (raw.kind !== "evidence") return null;
  const evidence = parseExecutionEvidence(raw.evidence);
  return evidence ? { kind: raw.kind, evidence } : null;
}

function executionResponse(result: Awaited<ReturnType<typeof commitExecutionMutation>>): Response {
  switch (result.kind) {
    case "ok": return Response.json(result.answer ?? { kind: "committed", event_id: result.event_id });
    case "missing": return errorResponse(new MissingEntityError(result.detail));
    case "conflict": return errorResponse(new ConflictError(result.detail));
    case "unauthorized": return errorResponse(new UnauthorizedError(result.detail));
  }
}
