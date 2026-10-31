/** Read-only report to run against restored authority and observation databases before cutover. */
import { sql } from "kysely";
import { openDatabase } from "../src/storage/database";
import { openDatabase as openObservationDatabase } from "../../observation/src/storage/database";

export interface CutoverPreflight {
  readonly run_states: readonly { readonly state: string; readonly count: number }[];
  readonly pending_authority_work: readonly { readonly kind: string; readonly count: number }[];
  readonly referenced_definition_ids: readonly { readonly id: string; readonly count: number }[];
  readonly missing_pinned_dependencies: readonly { readonly kind: string; readonly id: string }[];
  readonly observation_reference_counts: readonly { readonly kind: string; readonly count: number }[];
}

export async function cutoverPreflight(authorityUrl: string, observationUrl: string): Promise<CutoverPreflight> {
  const authority = openDatabase(authorityUrl);
  const observation = openObservationDatabase(observationUrl);
  try {
    const [states, attempts, intents, definitions, missingBundles, missingPrompts, observations] = await Promise.all([
      sql<{ state: string; count: number }>`SELECT COALESCE(root.status->>'kind', 'not_started') AS state, count(*)::integer AS count
        FROM authority.run r LEFT JOIN authority.unit root ON root.run_id = r.id AND root.id = r.root_unit_id
        GROUP BY 1 ORDER BY 1`.execute(authority),
      sql<{ count: number }>`SELECT count(*)::integer AS count FROM authority.attempt WHERE status->>'kind' = 'running'`.execute(authority),
      sql<{ status: string; count: number }>`SELECT status::text AS status, count(*)::integer AS count FROM authority.effect_intent
        WHERE status IN ('pending', 'stop_requested') GROUP BY status ORDER BY status`.execute(authority),
      sql<{ id: string; count: number }>`SELECT definition_bundle_id AS id, count(*)::integer AS count FROM authority.run GROUP BY 1 ORDER BY 1`.execute(authority),
      sql<{ id: string }>`SELECT DISTINCT r.definition_bundle_id AS id FROM authority.run r
        LEFT JOIN authority.definition_bundle b ON b.id = r.definition_bundle_id WHERE b.id IS NULL ORDER BY 1`.execute(authority),
      sql<{ id: string }>`SELECT DISTINCT p.key AS id FROM authority.definition_bundle b
        CROSS JOIN LATERAL jsonb_each_text(b.prompts) AS p(key, digest)
        LEFT JOIN authority.prompt_content c ON c.content_digest = p.digest WHERE c.content_digest IS NULL ORDER BY 1`.execute(authority),
      sql<{ kind: string; count: number }>`SELECT 'source_revision' AS kind, count(*)::integer AS count FROM observation.source_revision
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
        ...missingBundles.rows.map((row) => ({ kind: "definition_bundle", id: row.id })),
        ...missingPrompts.rows.map((row) => ({ kind: "prompt_content", id: row.id })),
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
