import type { OperatorCommandSubmission, OperatorDraftKey } from "../operator-contracts";

const DRAFT_PREFIX = "oakridge:operator:draft:";
const PENDING_PREFIX = "oakridge:operator:pending:";

export function operatorDraftIdentity(key: OperatorDraftKey): string {
  return JSON.stringify([key.run_id, key.scope_id, key.command_key, key.owner_version,
    key.targets.map((target) => [target.identity, target.version])]);
}

/**
 * What a mounted command form stands for: the command and its target revisions,
 * without the owner version. A version bump moves the draft under a new storage
 * identity but must not replace the form that is holding the operator's edits.
 */
export function operatorFormIdentity(key: OperatorDraftKey): string {
  return JSON.stringify([key.run_id, key.scope_id, key.command_key, key.targets.map((target) => [target.identity, target.version])]);
}

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
export function readPendingCommand(key: OperatorDraftKey): OperatorCommandSubmission | null {
  try {
    const raw = localStorage.getItem(PENDING_PREFIX + operatorDraftIdentity(key));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("request_id" in parsed) || typeof parsed.request_id !== "string"
      || !("payload" in parsed)) return null;
    return parsed as OperatorCommandSubmission;
  } catch { return null; }
}
export function savePendingCommand(input: OperatorCommandSubmission): void {
  localStorage.setItem(PENDING_PREFIX + operatorDraftIdentity(input), JSON.stringify(input));
}
export function clearPendingCommand(key: OperatorDraftKey): void {
  localStorage.removeItem(PENDING_PREFIX + operatorDraftIdentity(key));
}

export function findRetainedDrafts(key: OperatorDraftKey): readonly { readonly identity: string; readonly text: string }[] {
  const prefix = JSON.stringify([key.run_id, key.scope_id, key.command_key]).slice(0, -1) + ",";
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((storedKey): storedKey is string => storedKey !== null && storedKey.startsWith(DRAFT_PREFIX + prefix)
        && storedKey !== DRAFT_PREFIX + operatorDraftIdentity(key))
      .map((storedKey) => ({ identity: storedKey.slice(DRAFT_PREFIX.length), text: localStorage.getItem(storedKey) ?? "" }))
      .filter((draft) => draft.text.length > 0);
  } catch { return []; }
}

export function listPendingCommands(runId: string): readonly OperatorCommandSubmission[] {
  try {
    return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(PENDING_PREFIX))
      .map((key) => localStorage.getItem(key))
      .flatMap((raw) => {
        if (!raw) return [];
        try {
          const parsed = JSON.parse(raw) as OperatorCommandSubmission;
          return parsed.run_id === runId && typeof parsed.request_id === "string" ? [parsed] : [];
        } catch { return []; }
      });
  } catch { return []; }
}
