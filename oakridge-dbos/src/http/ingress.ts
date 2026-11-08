import { resolveLaunchableDefinition, type DefinitionId } from "../runtime/definition-store";
import type { Context, Hono } from "hono";
import { createHash } from "node:crypto";
import type { Event, Writer } from "../core-client/core-types";
import { selectApplicableEntries, type AnalysisLinkEntry } from "../domain/analysis-link-declaration";
import { err, ok, type ProjectId, type Result, type RunId } from "../domain/primitives";
import { parseRunConfig, type RunConfig } from "../domain/run-config";
import { commitAnalysisLinkDeclaration, commitDecisionWithLinks, commitEvent, launchRunId, type CommitDependencies, type CommitOutcome, type CommitRequest, type CommitResult } from "../storage/commit";
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
  readonly definition_id: DefinitionId; readonly input: unknown; readonly project_id?: string | null;
  /** Session settings keyed by stage, then by agent worker, and the run's automatic-grading choice. */
  readonly config?: RunConfig | null;
}
export interface DecideRequest extends IngressRequest {
  readonly decision: string; readonly target: string; readonly payload: unknown;
  /** Optional explicit links, declared against the tasks revision this decision approves. Nothing requires them. */
  readonly analysis_links?: readonly AnalysisLinkEntry[];
}
/** What an agent sends to publish a revision; its attempt comes from the session secret. */
export interface PublishRequest extends IngressRequest { readonly body: unknown; readonly predecessor: string | null; readonly subject: string | null }
/** Explicit producer-supplied links against one exact approved tasks revision. */
export interface DeclareLinksRequest extends IngressRequest { readonly tasks_revision_id: string; readonly entries: readonly AnalysisLinkEntry[] }
/** Nothing applicable was supplied, so nothing was journaled: missing links are valid and need no one's action. */
export interface NoDeclaration { readonly kind: "no_declaration"; readonly run_id: string }
/** Successful ingress returns the committed event; typed refusals use the shared error response. */
export type IngressResponse = IngressCommitted;
/** A committed (or replayed) ingress request: the only success body. */
export interface IngressCommitted { readonly kind: "committed"; readonly run_id: string; readonly event_id: string; readonly analysis_links?: DeclaredLinks }
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
  const config = raw.config === undefined || raw.config === null ? null : parseRunConfig(raw.config);
  if (raw.config !== undefined && raw.config !== null && config === null)
    return malformed("config.sessions maps each stage and worker to { harness, model, effort }; config.grading_enabled is a boolean");
  return ok({ request_id: raw.request_id, definition_id: raw.definition_id as DefinitionId, input: raw.input, project_id: raw.project_id ?? null, config });
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
    case "committed": return json({ kind: "committed", run_id, event_id: outcome.event_id }, 201);
    case "replayed": return outcome.receipt.kind === "committed" ? json({ kind: "committed", run_id, event_id: outcome.receipt.event_id })
      : errorResponse(new ConflictError(outcome.receipt.reason));
    case "rejected": return errorResponse(new ConflictError(outcome.reason));
    case "conflict": case "contended": return errorResponse(new ConflictError(outcome.detail));
    case "missing": return errorResponse(new MissingEntityError(outcome.detail));
  }
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

export interface IngressDependencies extends CommitDependencies {
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
      const resolved = resolveLaunchableDefinition(request.definition_id);
      if (!resolved.ok) return Response.json(resolved.error, { status: resolved.error.kind === "definition_not_launchable" ? 404 : 422 });
      const definition_id = resolved.value.definition_id;
      const project_id = request.project_id ? request.project_id as ProjectId : null;
      if (project_id && !await hasProject(deps.db, project_id)) return errorResponse(new MissingEntityError("project not found"));
      const run_id = launchRunId(request.request_id);
      return ingressResponse(run_id, await commit({ run_id, ingress_id: request.request_id, event: { kind: "launched", input: request.input },
        writer: operatorWriterFromCredential(c.req.raw), launch: { definition_id, project_id, config: request.config ?? null } }));
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
  /** A decision, and any links supplied with it. Supplying none is the ordinary case and journals nothing. */
  app.post("/api/runs/:run_id/units/:unit_id/reviews/:review/decide", async (c) => {
    const raw = await requestBody(c.req.raw);
    if (raw instanceof MalformedRequestError) return errorResponse(raw);
    const parsed = parseDecideRequest(raw);
    if (!parsed.ok) return errorResponse(parsed.error);
    const body = parsed.value;
    const run_id = param(c, "run_id") as RunId;
    const request = { run_id, ingress_id: body.request_id, writer: operatorWriterFromCredential(c.req.raw), event: { kind: "operator_decided" as const, unit: param(c, "unit_id"),
      review: param(c, "review"), decision: body.decision, target: body.target, payload: body.payload } };
    const entries = selectApplicableEntries(body.analysis_links ?? []);
    try {
      if (entries.length === 0) return ingressResponse(run_id, await commit(request));
      const { decision, links } = await commitDecisionWithLinks(deps, request, entries);
      const response = ingressResponse(run_id, decision);
      return response.ok && links ? Response.json({ ...await response.json() as IngressCommitted, analysis_links: declaredLinks(links) } satisfies IngressCommitted, { status: response.status }) : response;
    } catch (cause) { return fault(cause); }
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
    if (entries.length === 0) return Response.json({ kind: "no_declaration", run_id } satisfies NoDeclaration);
    try {
      return ingressResponse(run_id, await commitAnalysisLinkDeclaration(deps.db, { ingress_id: request_id,
        declaration: { run_id, tasks_revision_id, entries }, writer: operatorWriterFromCredential(c.req.raw) }));
    } catch (cause) { return fault(cause); }
  });

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
