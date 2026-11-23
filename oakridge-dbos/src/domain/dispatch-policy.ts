import { createHash } from "node:crypto";
import type { DispatchAuthorization, DispatchOperation, DispatchTarget, FeedbackItem } from "../core-client/core-types";
import { ok, traced, type Result, type TracedError } from "./primitives";

export type DispatchPolicy = { readonly kind: "operator_required" };
export type DispatchRefusal = TracedError;

export interface DispatchCheck {
  readonly operation: DispatchOperation;
  readonly item: FeedbackItem;
  readonly target: DispatchTarget;
  readonly instruction: string;
  readonly recipients: readonly string[];
  readonly stage_agent_workers: readonly string[];
  readonly authorizations: readonly DispatchAuthorization[];
}

export function assessmentFactId(prefix: string, parts: readonly string[]): string {
  return prefix + createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function selectAuthorizationId(check: Pick<DispatchCheck, "operation" | "item" | "target" | "instruction" | "recipients">): string {
  return assessmentFactId("da_", [check.item.id, check.operation, check.target.revision, check.instruction, ...check.recipients.toSorted()]);
}

export function validateRecipients(check: Pick<DispatchCheck, "recipients" | "stage_agent_workers" | "item">): Result<null, DispatchRefusal> {
  const { recipients, stage_agent_workers, item } = check;
  if (recipients.length === 0 || new Set(recipients).size !== recipients.length) {
    return traced("authorize_dispatch", item.id, "dispatch requires a non-empty, unique recipient set");
  }
  const invalid = recipients.find(worker => !stage_agent_workers.includes(worker));
  return invalid === undefined ? ok(null) : traced("authorize_dispatch", item.id, `recipient ${invalid} is not an agent worker of the target stage`);
}

export function authorizeDispatch(policy: DispatchPolicy, check: DispatchCheck): Result<DispatchAuthorization, DispatchRefusal> {
  const recipients = validateRecipients(check);
  if (!recipients.ok) return recipients;
  const id = selectAuthorizationId(check);
  const authorization = check.authorizations.find(value => value.id === id && value.policy === policy.kind);
  return authorization === undefined
    ? traced("authorize_dispatch", check.item.id, "dispatch not authorized for this instruction, target and recipient set")
    : ok(authorization);
}
