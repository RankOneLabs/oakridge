/** Read-only report to run against restored authority and observation databases before cutover. */
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database";
import { openDatabase as openObservationDatabase, type Database as ObservationDatabase } from "../../observation/src/storage/database";

export interface RunStateCount { readonly state: string; readonly count: number }
export interface PendingAuthorityWorkCount { readonly kind: string; readonly count: number }
export interface ReferencedDefinitionCount { readonly id: string; readonly count: number }
export interface MissingPinnedDependency { readonly kind: "definition_bundle" | "prompt_content"; readonly id: string }
export interface ObservationReferenceCount { readonly kind: string; readonly count: number }
interface CountRow { readonly count: number }
interface EffectIntentStatusCount { readonly status: string; readonly count: number }
interface DefinitionIdRow { readonly id: string }
interface RowSecurityAccess { readonly can_bypass_rls: boolean }

export interface CutoverPreflight {
  readonly run_states: readonly RunStateCount[];
  readonly pending_authority_work: readonly PendingAuthorityWorkCount[];
  readonly referenced_definition_ids: readonly ReferencedDefinitionCount[];
  readonly missing_pinned_dependencies: readonly MissingPinnedDependency[];
  readonly observation_reference_counts: readonly ObservationReferenceCount[];
}

async function requireCompleteObservationReadAccess(db: ObservationDatabase): Promise<void> {
  const access = await sql<RowSecurityAccess>`SELECT rolsuper OR rolbypassrls AS can_bypass_rls
    FROM pg_roles WHERE rolname = current_user`.execute(db);
  if (!access.rows[0]?.can_bypass_rls)
    throw new Error("cutover preflight requires an observation database role with BYPASSRLS or SUPERUSER to count all tenants");
}

export async function cutoverPreflight(authorityUrl: string, observationUrl: string): Promise<CutoverPreflight> {
  const authority = openDatabase(authorityUrl);
  const observation = openObservationDatabase(observationUrl);
  try {
    await requireCompleteObservationReadAccess(observation);
    const [states, attempts, intents, definitions, missingBundles, missingPrompts, observations] = await Promise.all([
      sql<RunStateCount>`SELECT COALESCE(root.status->>'kind', 'not_started') AS state, count(*)::integer AS count
        FROM authority.run r LEFT JOIN authority.unit root ON root.run_id = r.id AND root.id = r.root_unit_id
        GROUP BY 1 ORDER BY 1`.execute(authority),
      sql<CountRow>`SELECT count(*)::integer AS count FROM authority.attempt WHERE status->>'kind' = 'running'`.execute(authority),
      sql<EffectIntentStatusCount>`SELECT status::text AS status, count(*)::integer AS count FROM authority.effect_intent
        WHERE status IN ('pending', 'stop_requested') GROUP BY status ORDER BY status`.execute(authority),
      sql<ReferencedDefinitionCount>`SELECT definition_bundle_id AS id, count(*)::integer AS count FROM authority.run GROUP BY 1 ORDER BY 1`.execute(authority),
      sql<DefinitionIdRow>`SELECT DISTINCT r.definition_bundle_id AS id FROM authority.run r
        LEFT JOIN authority.definition_bundle b ON b.id = r.definition_bundle_id WHERE b.id IS NULL ORDER BY 1`.execute(authority),
      sql<DefinitionIdRow>`SELECT DISTINCT p.key AS id FROM authority.definition_bundle b
        CROSS JOIN LATERAL jsonb_each_text(b.prompts) AS p(key, digest)
        LEFT JOIN authority.prompt_content c ON c.content_digest = p.digest WHERE c.content_digest IS NULL ORDER BY 1`.execute(authority),
      sql<ObservationReferenceCount>`SELECT 'source_revision' AS kind, count(*)::integer AS count FROM observation.source_revision
        UNION ALL SELECT 'item_occurrence', count(*)::integer FROM observation.item_occurrence
        UNION ALL SELECT 'grade_observation', count(*)::integer FROM observation.grade_observation ORDER BY kind`.execute(observation),
    ]);
    return {
      run_states: states.rows, pending_authority_work: [
        { kind: "running_attempt", count: attempts.rows[0]?.count ?? 0 },
        ...intents.rows.map((row) => ({ kind: `effect_intent:${row.status}`, count: row.count })),
      ],
      referenced_definition_ids: definitions.rows,
      missing_pinned_dependencies: [
        ...missingBundles.rows.map((row): MissingPinnedDependency => ({ kind: "definition_bundle", id: row.id })),
        ...missingPrompts.rows.map((row): MissingPinnedDependency => ({ kind: "prompt_content", id: row.id })),
      ],
      observation_reference_counts: observations.rows,
    };
  } finally { await authority.destroy(); await observation.destroy(); }
}

if (import.meta.main) {
  const authorityUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
  const observationUrl = process.env.OBSERVATION_DATABASE_URL;
  if (!authorityUrl || !observationUrl) throw new Error("DBOS_SYSTEM_DATABASE_URL and OBSERVATION_DATABASE_URL are required");
  console.log(JSON.stringify(await cutoverPreflight(authorityUrl, observationUrl), null, 2));
}
