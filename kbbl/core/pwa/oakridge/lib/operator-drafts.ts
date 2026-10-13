import type { OperatorDecisionSubmit } from "../operator-contracts";

/** What a decision form edits: one decision on one unit, and the revision it decides (null for a retry or cancel). */
export interface OperatorDraftKey {
  readonly run_id: string; readonly unit_id: string; readonly decision_key: string; readonly target_revision_id: string | null;
}
/** A decision the operator submitted, retained until the authority acknowledges it. */
export interface OperatorDecisionSubmission extends OperatorDraftKey {
  readonly submit: OperatorDecisionSubmit; readonly request_id: string; readonly payload: unknown;
}

const DRAFT_PREFIX = "oakridge:operator:draft:";
const PENDING_PREFIX = "oakridge:operator:pending:";

export const operatorDraftIdentity = (key: OperatorDraftKey): string =>
  JSON.stringify([key.run_id, key.unit_id, key.decision_key, key.target_revision_id]);

export function readOperatorDraft(key: OperatorDraftKey): string {
  try { return localStorage.getItem(DRAFT_PREFIX + operatorDraftIdentity(key)) ?? ""; }
  catch { return ""; }
}
export function saveOperatorDraft(key: OperatorDraftKey, value: string): void {
  try { localStorage.setItem(DRAFT_PREFIX + operatorDraftIdentity(key), value); } catch { /* storage may be disabled */ }
}
export function clearOperatorDraft(key: OperatorDraftKey): void {
  try { localStorage.removeItem(DRAFT_PREFIX + operatorDraftIdentity(key)); } catch { /* storage may be disabled */ }
}
export function readPendingDecision(key: OperatorDraftKey): OperatorDecisionSubmission | null {
  try {
    const raw = localStorage.getItem(PENDING_PREFIX + operatorDraftIdentity(key));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("request_id" in parsed) || typeof parsed.request_id !== "string"
      || !("payload" in parsed) || !("submit" in parsed) || !parsed.submit || typeof parsed.submit !== "object") return null;
    return parsed as OperatorDecisionSubmission;
  } catch { return null; }
}
export function savePendingDecision(input: OperatorDecisionSubmission): void {
  localStorage.setItem(PENDING_PREFIX + operatorDraftIdentity(input), JSON.stringify(input));
}
export function clearPendingDecision(key: OperatorDraftKey): void {
  localStorage.removeItem(PENDING_PREFIX + operatorDraftIdentity(key));
}

export function findRetainedDrafts(key: OperatorDraftKey): readonly { readonly identity: string; readonly text: string }[] {
  const prefix = JSON.stringify([key.run_id, key.unit_id, key.decision_key]).slice(0, -1) + ",";
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((storedKey): storedKey is string => storedKey !== null && storedKey.startsWith(DRAFT_PREFIX + prefix)
        && storedKey !== DRAFT_PREFIX + operatorDraftIdentity(key))
      .map((storedKey) => ({ identity: storedKey.slice(DRAFT_PREFIX.length), text: localStorage.getItem(storedKey) ?? "" }))
      .filter((draft) => draft.text.length > 0);
  } catch { return []; }
}

export function listPendingDecisions(runId: string): readonly OperatorDecisionSubmission[] {
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(PENDING_PREFIX))
      .map((key) => localStorage.getItem(key))
      .flatMap((raw) => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw) as OperatorDecisionSubmission;
          return parsed.run_id === runId && typeof parsed.request_id === "string" ? [parsed] : [];
        } catch { return []; }
      });
  } catch { return []; }
}
