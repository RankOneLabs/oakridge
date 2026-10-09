import type { CoreDomainError, CoreTransportError, CoreTransportKind } from "./generated-contracts";
import type { Result } from "../domain/primitives";

export type CoreFailure =
  | { readonly kind: "domain"; readonly detail: CoreDomainError }
  | { readonly kind: "transport"; readonly detail: CoreTransportError };
export type CoreResult<T> = Result<T, CoreFailure>;

export function transportFailure<T>(kind: CoreTransportKind, detail: string): CoreResult<T> {
  return { ok: false, error: { kind: "transport", detail: { kind, detail } } };
}
