import type { DefinitionBundle, DecisionOutcome } from "../core-client/generated-contracts";
import type { ScopeInstanceRecord } from "../storage/schema-records";
import { selectAvailableCommands } from "./scope-view";

export type InboxItem =
  | { readonly kind: "command"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly key: string; readonly label: string; readonly consequence: string }
  | { readonly kind: "wait"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly reason: string; readonly label: string }
  | { readonly kind: "diagnostic"; readonly run_id: string; readonly scope_id: string; readonly scope_version: number; readonly detail: string };
export interface InboxRow extends ScopeInstanceRecord { readonly source: DefinitionBundle | null; readonly decision: DecisionOutcome | null;
  readonly diagnostics?: readonly { readonly fact_key: string }[] | null }
export function selectInboxItems(row: InboxRow): readonly InboxItem[] {
  const base = { run_id: row.run_id, scope_id: row.id, scope_version: Number(row.version) };
  try {
    if (!row.source || !row.source.scopes.some((scope) => scope.key === row.scope_key))
      return [{ ...base, kind: "diagnostic", detail: "pinned scope definition is unavailable" }];
    const commands: InboxItem[] = selectAvailableCommands(row.source, row).map((command) =>
      ({ ...base, kind: "command", key: command.key, label: command.label, consequence: command.consequence }));
    if (row.decision?.kind === "wait" && !row.is_terminal)
      commands.push({ ...base, kind: "wait", reason: row.decision.reason, label: row.decision.attention?.label ?? row.decision.reason });
    if (row.decision?.kind === "reject")
      commands.push({ ...base, kind: "diagnostic", detail: row.decision.error });
    const error_keys = new Set(row.source.scopes.find((scope) => scope.key === row.scope_key)?.errors?.map((item) => item.key) ?? []);
    for (const item of row.diagnostics ?? []) if (error_keys.has(item.fact_key))
      commands.push({ ...base, kind: "diagnostic", detail: item.fact_key });
    return commands;
  } catch {
    return [{ ...base, kind: "diagnostic", detail: "scope projection is damaged" }];
  }
}

export interface InboxPage {
  readonly cursor: readonly { readonly scope_id: string; readonly version: number }[];
  readonly items: readonly InboxItem[]; readonly next_cursor: string | null;
}
/** Review work and diagnostics from the existing inbox projection. */
export type ReviewInbox = InboxPage;
