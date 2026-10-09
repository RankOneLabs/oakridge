import type { DefinitionBundle, InvocationSetting } from "../../core-client/generated-contracts";
import type { ScopeInstanceRecord } from "../../storage/schema-records";
import type { StableInvocation } from "../provider";
import { CORE_MAX_FRAME_BYTES, CORE_PROTOCOL_VERSION } from "../../core-client/generated-contracts";
import type { AuthoritySnapshot } from "../../storage/snapshot-reader";

export const MAX_SNAPSHOT_BYTES = CORE_MAX_FRAME_BYTES;
export type InvocationSettingRole = "result_fact" | "evidence_fact";
export function settingForRole(settings: readonly InvocationSetting[], role: InvocationSettingRole): string | null {
  return settings.find((setting) => setting.key === role)?.value ?? null;
}
export interface SnapshotMeasurement { readonly roots: AuthoritySnapshot["reads"]; readonly bytes: number; readonly largest_roots: readonly { readonly root: string; readonly bytes: number }[] }
const WIDEST_EVALUATE_ENVELOPE = { version: CORE_PROTOCOL_VERSION, request_id: String(Number.MAX_SAFE_INTEGER), operation: "evaluate", bundle_digest: "f".repeat(64) } as const;
export function measureAuthoritySnapshot(source: AuthoritySnapshot): SnapshotMeasurement {
  const { bundle_digest, ...envelope } = WIDEST_EVALUATE_ENVELOPE;
  const frame = JSON.stringify({ ...envelope, input: { bundle_digest, snapshot: source.snapshot } }) + "\n";
  return { roots: source.reads, bytes: Buffer.byteLength(frame),
    largest_roots: source.snapshot.observations.map((observation) => ({ root: JSON.stringify(observation.root),
      bytes: Buffer.byteLength(JSON.stringify(observation)) })).sort((a, b) => b.bytes - a.bytes).slice(0, 5) };
}

interface PublicationContractSelection { readonly invocation: StableInvocation; readonly bundle: DefinitionBundle; readonly scope: Pick<ScopeInstanceRecord, "id" | "run_id" | "child_key" | "scope_key">; readonly publication_secret?: string }

/** The provider receives the selected output authority and pinned schema definitions. */
export function selectedPublicationInstructions({ invocation, bundle, scope, publication_secret }: PublicationContractSelection): string {
  const declaration = bundle.scopes.find((item) => item.key === scope.scope_key)?.outputs;
  const outputs = invocation.selection.definition.outputs.map((key) => ({ key, schema: declaration?.find((output) => output.key === key)?.schema ?? null,
    collection_key: declaration?.find((output) => output.key === key)?.collection_key ?? null }));
  const base_url = process.env.OAKRIDGE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8790"}`;
  const endpoint = `${base_url}/api/runs/${encodeURIComponent(scope.run_id)}/scopes/${encodeURIComponent(scope.id)}/executions/${encodeURIComponent(invocation.execution_id)}`;
  const evidence = settingForRole(invocation.selection.definition.settings, "evidence_fact");
  return `\n\n## Selected publication contract\n\n${publication_secret ? `Authorization: Bearer ${publication_secret}\n` : ""}GET ${endpoint}/contract for current publication pointers and remaining frame budget.\nPublish exactly these outputs: ${JSON.stringify(outputs)}.\nPUT ${endpoint}/outputs/<output-key>\nContent-Type: application/json\n\nSend {"request_id":"<stable unique key>","predecessor_id":null,"collection_key":"","body":<typed output body>}. Use the collection member's declared key for collection_key. For a revision, use the current predecessor revision from the contract route. Retry identical content with the same request_id. A different body requires a new request_id. Never republish a retained output.\n\n${evidence ? `For explicit unchanged evidence, POST ${endpoint}/facts/${evidence} with {"request_id":"<stable unique key>","payload":<typed evidence>}. Use {"brand":"artifact_revision","id":"<pinned revision>"} for each revision reference in this raw evidence payload. This preserves the assessment revision and accepted build.\n\n` : ""}Pinned schema definitions:\n${JSON.stringify(bundle.schemas)}\n`;
}
