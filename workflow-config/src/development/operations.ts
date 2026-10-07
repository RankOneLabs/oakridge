import type { OperationManifest } from "../source-contracts";

interface ProviderCatalogData {
  readonly operations: (OperationManifest & { readonly emitted_codes: string[] })[];
  readonly providers: readonly { readonly kind: string; readonly input_contract: string }[];
}

/** Checked-in data generated from oakridge-dbos/src/effects/provider-catalog.ts. */
const catalog = await Bun.file(new URL("../../provider-catalog.json", import.meta.url)).json() as ProviderCatalogData;
export const operations: OperationManifest[] = catalog.operations.map(({ emitted_codes: _provider_owned_codes, ...operation }) => operation);
