import type { Context, Hono } from "hono";
import { createHash } from "node:crypto";
import type { Event, Writer } from "../core-client/core-types";
import { err, ok, type ProjectId, type Result, type RunId } from "../domain/primitives";
import { parseRunConfig, type RunConfig } from "../domain/run-config";
import { commitEvent, launchRunId, type CommitDependencies, type CommitOutcome, type CommitRequest, type CommitResult } from "../storage/commit";
import { readSessionAttempt } from "../storage/read-store";
import { findLaunchableDefinition, hasProject } from "../storage/registry-store";
import { operatorWriterFromCredential } from "./control-auth";
import { ConflictError, errorResponse, fault, HistoricalRunReadOnlyError, MalformedRequestError, MissingEntityError, requestBody, UnauthorizedError } from "./errors";

/**
 * Ingress (part 1 §7.1): HTTP to events. Each route checks authentication and
 * request shape, resolves the writer from the credential presented, and makes
 * exactly one commit call; everything else is decided in `step`. A writer, or
 * a `by`, in a request body is never read.
 */

/** Every ingress request carries the id that makes it idempotent. */
export interface IngressRequest { readonly request_id: string }
export interface LaunchRequest extends IngressRequest {
  readonly digest: string; readonly input: unknown; readonly project_id?: string | null;
  /** Session settings keyed by stage, then by agent worker. */
  readonly config?: RunConfig | null;
}
export interface DecideRequest extends IngressRequest { readonly decision: string; readonly target: string; readonly payload: unknown }
/** What an agent sends to publish a revision; its attempt comes from the session secret. */
export interface PublishRequest extends IngressRequest { readonly body: unknown; readonly predecessor: string | null; readonly subject: string | null }
/** Successful ingress returns the committed event; typed refusals use the shared error response. */
export type IngressResponse = IngressCommitted;
/** A committed (or replayed) ingress request: the only success body. */
export interface IngressCommitted { readonly kind: "committed"; readonly run_id: string; readonly event_id: string }

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
  if (!isFields(raw) || !isRequestId(raw.request_id) || typeof raw.digest !== "string" || !("input" in raw) || !isOptionalId(raw.project_id))
    return malformed("request_id (1 to 200 characters), digest and input are required");
  const config = raw.config === undefined || raw.config === null ? null : parseRunConfig(raw.config);
  if (raw.config !== undefined && raw.config !== null && config === null)
    return malformed("config.sessions maps each stage and worker to { harness, model, effort }");
  return ok({ request_id: raw.request_id, digest: raw.digest, input: raw.input, project_id: raw.project_id ?? null, config });
}
export function parseDecideRequest(raw: unknown): Parsed<DecideRequest> {
  if (!isFields(raw) || !isRequestId(raw.request_id) || !isKey(raw.decision) || !isKey(raw.target) || !("payload" in raw))
    return malformed("request_id, decision, target and payload are required");
  return ok({ request_id: raw.request_id, decision: raw.decision, target: raw.target, payload: raw.payload });
}
export function parsePublishRequest(raw: unknown): Parsed<PublishRequest> {
  if (!isFields(raw) || !isRequestId(raw.request_id) || !("body" in raw) || !isOptionalId(raw.predecessor) || !isOptionalId(raw.subject))
    return malformed("request_id and body are required; predecessor and subject are revision ids or null");
  return ok({ request_id: raw.request_id, body: raw.body, predecessor: raw.predecessor ?? null, subject: raw.subject ?? null });
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
    case "historical_run_read_only": return errorResponse(new HistoricalRunReadOnlyError(outcome.detail));
    case "missing": return errorResponse(new MissingEntityError(outcome.detail));
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
      const definition_bundle_id = await findLaunchableDefinition(deps.db, request.digest);
      if (!definition_bundle_id) return errorResponse(new MissingEntityError("definition not found"));
      const project_id = request.project_id ? request.project_id as ProjectId : null;
      if (project_id && !await hasProject(deps.db, project_id)) return errorResponse(new MissingEntityError("project not found"));
      const run_id = launchRunId(request.request_id);
      return ingressResponse(run_id, await commit({ run_id, ingress_id: request.request_id, event: { kind: "launched", input: request.input },
        writer: operatorWriterFromCredential(c.req.raw), launch: { definition_bundle_id, project_id, config: request.config ?? null } }));
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
  app.post("/api/runs/:run_id/units/:unit_id/reviews/:review/decide", operatorEvent(parseDecideRequest, (c, body) =>
    ({ kind: "operator_decided", unit: param(c, "unit_id"), review: param(c, "review"), decision: body.decision, target: body.target, payload: body.payload })));

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
