import type { DefinitionBundle } from "../../core-client/generated-contracts";
import type { ScopeInstanceRecord } from "../../storage/schema-records";
import type { StableInvocation } from "../provider";

interface PublicationContractSelection { readonly invocation: StableInvocation; readonly bundle: DefinitionBundle; readonly scope: Pick<ScopeInstanceRecord, "id" | "run_id" | "child_key" | "scope_key"> }

/** The provider receives the selected output authority and pinned schema definitions. */
export function selectedPublicationInstructions({ invocation, bundle, scope }: PublicationContractSelection): string {
  const declaration = bundle.scopes.find((item) => item.key === scope.scope_key)?.outputs;
  const outputs = invocation.selection.definition.outputs.map((key) => ({ key, schema: declaration?.find((output) => output.key === key)?.schema ?? null,
    collection_key: declaration?.find((output) => output.key === key)?.collection_key ?? null }));
  const base_url = process.env.OAKRIDGE_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8790"}`;
  const endpoint = `${base_url}/api/runs/${encodeURIComponent(scope.run_id)}/scopes/${encodeURIComponent(scope.id)}/executions/${encodeURIComponent(invocation.execution_id)}`;
  const evidence = invocation.selection.definition.settings.find((setting) => setting.key === "evidence_fact")?.value;
  return `\n\n## Selected publication contract\n\nPublish exactly these outputs: ${JSON.stringify(outputs)}.\nPUT ${endpoint}/outputs/<output-key>\nContent-Type: application/json\n\nSend {"request_id":"<stable unique key>","predecessor_id":null,"collection_key":"","body":<typed output body>}. Use the collection member's declared key for collection_key. For a revision, name the current predecessor revision; inspect GET ${base_url}/api/runs/${scope.run_id}/scopes/${scope.id} for current pointers. Retry identical content with the same request_id. A different body requires a new request_id. Never republish a retained output.\n\n${evidence ? `For explicit unchanged evidence, POST ${endpoint}/facts/${evidence} with {"request_id":"<stable unique key>","payload":<typed evidence>}. Use {"brand":"artifact_revision","id":"<pinned revision>"} for each revision reference in this raw evidence payload. This preserves the assessment revision and accepted build.\n\n` : ""}Pinned schema definitions:\n${JSON.stringify(bundle.schemas)}\n`;
}
