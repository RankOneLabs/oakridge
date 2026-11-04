import { z } from "zod";

export interface CaptureVerificationOptions { readonly run_id: string; readonly url: string;
  readonly ingest_token: string; readonly read_token: string }
export interface CaptureVerification { readonly run_id: string; readonly revisions: readonly string[];
  readonly occurrence_count: number; readonly relation_count: number }
const itemPage = z.object({ total: z.number().int().nonnegative(), items: z.array(z.object({ occurrence_id: z.string(), revision_id: z.string(), run_id: z.string(), producer: z.string(), namespace: z.string() })) });
const lineagePage = z.object({ total: z.number().int().nonnegative(), edges: z.array(z.object({ relation_id: z.string() })) });
const revisionSchema = z.object({ run_id: z.string() });

/** Deployment smoke check against stored rows for a known reviewed run, never configuration alone. */
export async function verifyDbosCapture(options: CaptureVerificationOptions,
  transport: typeof fetch = fetch): Promise<CaptureVerification> {
  if (!options.ingest_token) throw new Error("OAKRIDGE_OBSERVATION_INGEST_TOKEN is required: capture verification cannot run without it");
  if (!options.read_token) throw new Error("OBSERVATION_READ_TOKEN is required to verify captured rows");
  if (!options.url || !options.run_id) throw new Error("observation URL and a known reviewed run id are required");
  const read = async (path: string, token = options.read_token): Promise<unknown> => {
    const response = await transport(`${options.url.replace(/\/$/, "")}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`capture verification failed: ${path} returned HTTP ${response.status}`);
    return response.json();
  };
  await read("/v1/sources/oakridge/cursor", options.ingest_token);
  const revisions = new Set<string>(), relations = new Set<string>();
  let occurrence_count = 0;
  for (let offset = 0; ; offset += 200) {
    const page = itemPage.parse(await read(`/v1/runs/${encodeURIComponent(options.run_id)}/items?limit=200&offset=${offset}`));
    if (page.items.length === 0 && offset < page.total) throw new Error("capture verification failed: item listing truncated");
    for (const item of page.items) {
      if (item.run_id !== options.run_id) throw new Error("capture verification failed: occurrence belongs to another run");
      revisions.add(`${item.producer}:${item.namespace}:${item.revision_id}`); occurrence_count++;
      const lineage = lineagePage.parse(await read(`/v1/items/${encodeURIComponent(item.occurrence_id)}/lineage?limit=200`));
      for (const relation of lineage.edges) relations.add(relation.relation_id);
    }
    if (offset + page.items.length >= page.total) break;
  }
  for (const id of revisions) {
    const revision = revisionSchema.parse(await read(`/v1/source-revisions/${encodeURIComponent(id)}`));
    if (revision.run_id !== options.run_id) throw new Error("capture verification failed: revision belongs to another run");
  }
  if (!revisions.size || !occurrence_count || !relations.size)
    throw new Error(`capture verification failed for ${options.run_id}: expected stored source revisions, item occurrences and item relations; found ${revisions.size}, ${occurrence_count}, ${relations.size}`);
  return { run_id: options.run_id, revisions: [...revisions].sort(), occurrence_count, relation_count: relations.size };
}

if (import.meta.main) {
  const index = process.argv.indexOf("--run-id");
  const run_id = index < 0 ? "" : process.argv[index + 1] ?? "";
  const result = await verifyDbosCapture({ run_id, url: process.env.OAKRIDGE_OBSERVATION_URL ?? "",
    ingest_token: process.env.OAKRIDGE_OBSERVATION_INGEST_TOKEN ?? "", read_token: process.env.OBSERVATION_READ_TOKEN ?? "" });
  console.log(JSON.stringify(result, null, 2));
}
