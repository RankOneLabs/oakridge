import type { OperatorArtifactDetail, OperatorRunInboxBatch, OperatorRunView, OperatorUnitView } from "../operator-contracts";
import { fail, ok, type AdapterResult } from "./core";

const record = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const nullableString = (value: unknown): value is string | null => value === null || string(value);
const array = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const status = (value: unknown): boolean => record(value) && ["not_started", "active", "done", "cancelled"].includes(String(value.kind));
const revision = (value: unknown): boolean => record(value) && string(value.id) && string(value.run_id) && string(value.unit_id)
  && string(value.artifact_key) && string(value.created_at) && typeof value.number === "number";
const artifact = (value: unknown): boolean => record(value) && string(value.run_id) && string(value.unit_id)
  && string(value.artifact_key) && string(value.schema) && typeof value.revision_count === "number"
  && typeof value.is_reviewable === "boolean" && typeof value.is_editable === "boolean"
  && (value.latest_revision === null || revision(value.latest_revision));
const attempt = (value: unknown): boolean => record(value) && string(value.id) && string(value.unit_id) && string(value.worker)
  && typeof value.number === "number" && ["pending", "running", "succeeded", "failed"].includes(String(value.status))
  && ["initial", "revise", "review"].includes(String(value.mode)) && record(value.cause)
  && ["missing", "changes_requested", "review_of", "retry", "periodic"].includes(String(value.cause.kind))
  && (value.failure === null || record(value.failure) && string(value.failure.code) && string(value.failure.detail))
  && nullableString(value.kbbl_session_id) && string(value.created_at) && typeof value.is_current === "boolean";
const submit = (value: unknown): boolean => record(value) && (
  value.kind === "cancel" || value.kind === "retry" && string(value.worker)
  || value.kind === "review" && string(value.review) && string(value.decision) && string(value.target_revision_id)
    && ["approve", "request_changes"].includes(String(value.effect)));
const decision = (value: unknown): boolean => record(value) && string(value.key) && string(value.label)
  && array(value.fields) && value.fields.every((field) => record(field) && string(field.key) && string(field.label))
  && submit(value.submit);
const unit = (value: unknown): boolean => record(value) && string(value.unit_id) && string(value.run_id)
  && string(value.unit_key) && string(value.label) && nullableString(value.stage) && nullableString(value.collection_key)
  && array(value.depends_on) && value.depends_on.every(string) && status(value.status)
  && (value.attention === null || record(value.attention) && (value.attention.kind === "waiting" && string(value.attention.reason)
    || value.attention.kind === "stalled" && string(value.attention.detail)))
  && array(value.decisions) && value.decisions.every(decision)
  && array(value.attempts) && value.attempts.every(attempt)
  && array(value.artifacts) && value.artifacts.every(artifact);

export function parseRunView(value: unknown): AdapterResult<OperatorRunView> {
  if (!record(value) || !string(value.run_id) || !string(value.definition_bundle_id) || !string(value.definition_digest)
      || !string(value.created_at) || !nullableString(value.archived_at) || !status(value.status)
      || !array(value.units)) return fail("parse run", "invalid run view");
  return ok(value as unknown as OperatorRunView);
}

export function parseUnitViews(value: unknown): AdapterResult<readonly OperatorUnitView[]> {
  if (!array(value) || !value.every(unit)) return fail("parse units", "invalid unit view list");
  return ok(value as unknown as readonly OperatorUnitView[]);
}

export function parseUnitView(value: unknown): AdapterResult<OperatorUnitView> {
  return unit(value) ? ok(value as unknown as OperatorUnitView) : fail("parse unit", "invalid unit view");
}

export function parseArtifactDetail(value: unknown): AdapterResult<OperatorArtifactDetail> {
  if (!record(value) || !string(value.run_id) || !string(value.unit_id) || !string(value.artifact_key)
      || !string(value.schema) || !array(value.revisions) || !value.revisions.every(revision)
      || !array(value.decisions)) return fail("parse artifact", "invalid artifact detail");
  return ok(value as unknown as OperatorArtifactDetail);
}

export function parseRunInboxBatch(value: unknown): AdapterResult<OperatorRunInboxBatch> {
  if (!record(value) || !array(value.items) || !value.items.every((entry) => record(entry) && string(entry.run_id)
      && array(entry.items) && entry.items.every((item) => record(item) && string(item.kind) && string(item.run_id) && string(item.unit_id))))
    return fail("parse run inbox batch", "invalid batch");
  return ok(value as unknown as OperatorRunInboxBatch);
}
