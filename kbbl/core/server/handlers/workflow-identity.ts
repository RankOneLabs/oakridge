import { parsePrIntegration } from "../../../../oakridge-dbos/src/domain/pr-integration";
import type { AcpSessionWorkflowIdentity } from "../../acp/types";

type WorkflowIdentityParseResult = { value: AcpSessionWorkflowIdentity | null } | { error: string };

/**
 * Parses the optional `workflow` member of a resumable ensure body: the run,
 * unit and worker of the Oakridge attempt the session serves. Absence is not
 * an error (most sessions carry no workflow identity); it maps to null.
 */
export function parseWorkflowIdentity(
  raw: unknown,
): WorkflowIdentityParseResult {
  if (raw === undefined) return { value: null };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "workflow must be an object" };
  }
  const value = raw as { readonly [Field in keyof AcpSessionWorkflowIdentity]?: unknown };
  const fields = { run_id: value.run_id, unit_id: value.unit_id, worker: value.worker };
  for (const [name, field] of Object.entries(fields)) {
    if (typeof field !== "string" || field.trim() === "") return { error: `workflow.${name} must be a non-empty string` };
    if (field.trim().length > 200) return { error: `workflow.${name} must be at most 200 characters` };
  }
  const integration = parsePrIntegration(value.pr_integration ?? "gated-review");
  if (integration === null) return { error: "workflow.pr_integration is invalid" };
  const digest = value.pr_skill_digest ?? null;
  if (digest !== null && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) return { error: "workflow.pr_skill_digest is invalid" };
  return { value: { run_id: (fields.run_id as string).trim(), unit_id: (fields.unit_id as string).trim(), worker: (fields.worker as string).trim(), pr_integration: integration, pr_skill_digest: digest } };
}

