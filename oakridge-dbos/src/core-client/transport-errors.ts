import type { CoreDomainError, CoreTransportError, CoreTransportKind } from "./generated-contracts";

export type CoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly kind: "domain"; readonly detail: CoreDomainError } }
  | { readonly ok: false; readonly error: { readonly kind: "transport"; readonly detail: CoreTransportError } };

export function transportFailure<T>(kind: CoreTransportKind, detail: string): CoreResult<T> {
  return { ok: false, error: { kind: "transport", detail: { kind, detail } } };
}
