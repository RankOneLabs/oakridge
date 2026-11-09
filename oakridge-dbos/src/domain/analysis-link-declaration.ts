/**
 * The producer's explicit statement that original analysis findings assess tracked tasks, made
 * against one exact approved tasks revision. Nothing here is inferred: an entry exists only because
 * a caller supplied it, and a finding with no entry simply has no link.
 */
export const ANALYSIS_LINKS_DECLARED = "analysis_links_declared";
export const TASKS_ARTIFACT = "tasks";
export const ANALYSIS_ARTIFACT = "analysis";

/** One original finding, addressed by its exact revision and path, and the tasks it assesses. */
export interface AnalysisLinkEntry {
  readonly source_revision_id: string;
  readonly item_path: string;
  readonly task_ids: readonly string[];
}
export interface AnalysisLinkDeclaration {
  readonly run_id: string;
  readonly tasks_revision_id: string;
  readonly entries: readonly AnalysisLinkEntry[];
}
/** The journaled event. It never reaches the core's `step`: it advances no workflow state. */
export interface AnalysisLinksDeclared extends AnalysisLinkDeclaration { readonly kind: typeof ANALYSIS_LINKS_DECLARED }

/** An entry naming no task says nothing, so a declaration of only such entries is no declaration. */
export const selectApplicableEntries = (entries: readonly AnalysisLinkEntry[]): readonly AnalysisLinkEntry[] =>
  entries.filter((entry) => entry.task_ids.length > 0);

/** What the authority holds for the addresses a declaration names, read under the run lock. */
export interface DeclarationAuthority {
  readonly tasks_revision: { readonly artifact: string } | null;
  readonly is_tasks_revision_approved: boolean;
  readonly sources: ReadonlyMap<string, { readonly artifact: string; readonly body: unknown }>;
}

const FINDING_PATH = /^\/findings\/(0|[1-9][0-9]*)$/;
function findingExists(body: unknown, item_path: string): boolean {
  const index = FINDING_PATH.exec(item_path)?.[1];
  if (index === undefined || body === null || typeof body !== "object" || !("findings" in body) || !Array.isArray(body.findings)) return false;
  return body.findings[Number(index)] !== undefined;
}

/** Why the exact named context refuses this declaration, or null when every address holds. */
export function selectDeclarationRefusal(declaration: AnalysisLinkDeclaration, authority: DeclarationAuthority): string | null {
  const { tasks_revision_id } = declaration;
  if (authority.tasks_revision === null) return `revision ${tasks_revision_id} is not part of run ${declaration.run_id}`;
  if (authority.tasks_revision.artifact !== TASKS_ARTIFACT) return `revision ${tasks_revision_id} is a ${authority.tasks_revision.artifact}, not a ${TASKS_ARTIFACT} revision`;
  if (!authority.is_tasks_revision_approved) return `${TASKS_ARTIFACT} revision ${tasks_revision_id} is not approved`;
  for (const entry of declaration.entries) {
    const source = authority.sources.get(entry.source_revision_id);
    if (!source) return `revision ${entry.source_revision_id} is not part of run ${declaration.run_id}`;
    if (source.artifact !== ANALYSIS_ARTIFACT) return `revision ${entry.source_revision_id} is a ${source.artifact}, not an ${ANALYSIS_ARTIFACT} revision`;
    if (!findingExists(source.body, entry.item_path)) return `revision ${entry.source_revision_id} has no finding at ${entry.item_path}`;
  }
  return null;
}
