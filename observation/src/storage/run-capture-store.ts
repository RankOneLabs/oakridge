import type { ItemOccurrenceId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { CapturedItem, CapturedRevision } from "../grading/evidence-packages/capture";
import { oakridgeDevelopmentCatalogue } from "../projection/catalogue/oakridge-development";
import { selectRevision } from "../projection/extractor";
import { withTenant, type Database, type TenantScope } from "./database";

export interface RunCaptureError { readonly operation: "run_capture"; readonly entity_id: string; readonly detail: string }

function occurrenceKey(revision_id: string, extractor_id: string, item_selector: string, item_id_or_path: string): string {
  return [revision_id, extractor_id, item_selector, item_id_or_path].join("\u0000");
}

/** Re-selects each captured revision with the catalogue, so items keep their typed links, and pairs
 * every item with the occurrence the projection stored for it. Unprojected items are left out. */
export async function loadRunCapture(db: Database, tenant: TenantScope, run_id: string)
  : Promise<Result<readonly CapturedRevision[], RunCaptureError>> {
  try {
    return await withTenant(db, tenant, async (trx) => {
      const revisions = await trx.selectFrom("observation.source_revision")
        .select(["revision_id", "unit_id", "artifact_kind", "artifact_schema_version", "body", "recorded_at", "predecessor_id"])
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("run_id", "=", run_id).execute();
      if (revisions.length === 0) return err({ operation: "run_capture", entity_id: run_id, detail: "no captured revisions for run" });
      const occurrences = await trx.selectFrom("observation.item_occurrence")
        .select(["occurrence_id", "revision_id", "extractor_id", "item_selector", "item_id_or_path"])
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("run_id", "=", run_id).execute();
      const ids = new Map(occurrences.map((row) => [occurrenceKey(row.revision_id, row.extractor_id, row.item_selector,
        row.item_id_or_path), row.occurrence_id as ItemOccurrenceId]));
      return ok(revisions.map((revision): CapturedRevision => {
        const pass = selectRevision(revision.body as JsonValue, revision.revision_id,
          oakridgeDevelopmentCatalogue(revision.artifact_kind, revision.artifact_schema_version));
        const items = pass.items.flatMap(({ definition, item }): CapturedItem[] => {
          const occurrence_id = ids.get(occurrenceKey(revision.revision_id, definition.extractor_id,
            item.item_selector, item.item_id_or_path));
          return occurrence_id ? [{ ...item, occurrence_id, revision_id: revision.revision_id }] : [];
        });
        return { revision_id: revision.revision_id, unit_id: revision.unit_id, artifact_kind: revision.artifact_kind,
          recorded_at: revision.recorded_at, predecessor_id: revision.predecessor_id, items };
      }));
    });
  } catch (cause) { return err({ operation: "run_capture", entity_id: run_id, detail: String(cause) }); }
}
