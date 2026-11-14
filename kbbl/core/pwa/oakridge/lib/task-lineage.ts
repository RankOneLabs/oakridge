import type { ObservationLineageEntry } from "../grading-contracts/grading/composite";
export interface TaskLineageGroup { kind: string; label: string; entries: ObservationLineageEntry[] }
const LABELS: Readonly<Record<string, string>> = { task: "Task definition", acceptance_entry: "Plan contributions", build_item: "Brief build items", assessment_finding: "Assessment findings" };
export function selectTaskLineageGroups(entries: readonly ObservationLineageEntry[]): TaskLineageGroup[] {
  const groups = new Map<string, TaskLineageGroup>();
  for (const entry of entries) {
    const kind = entry.kind === "edge" ? "relationships" : entry.kind === "occurrence" ? entry.item_kind : entry.item.item_kind;
    const group = groups.get(kind) ?? { kind, label: LABELS[kind] ?? kind, entries: [] };
    group.entries.push(entry);
    groups.set(kind, group);
  }
  return [...groups.values()];
}
