import type { AuthStatus } from "../../auth-wire";
import type { Result } from "./result";

/** Why a token did not sign the browser in. */
export type SignInFailure =
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable"; readonly detail: string };

/** The PWA asks for the control token only when kbbl requires one and the browser's cookie does not carry it. */
export const selectIsSignInRequired = (status: AuthStatus | null): boolean =>
  status !== null && status.is_required && !status.is_authenticated;

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const response = await fetch("/auth/status");
  if (!response.ok) throw new Error(`auth status: ${response.status}`);
  return await response.json() as AuthStatus;
}

/** Exchanges the control token for kbbl's HttpOnly cookie; the token itself is never kept in the page. */
export async function signInWithToken(token: string): Promise<Result<null, SignInFailure>> {
  let response: Response;
  try { response = await fetch("/auth/cookie", { method: "POST", headers: { authorization: `Bearer ${token}` } }); }
  catch (error) { return { ok: false, error: { kind: "unavailable", detail: String(error) } }; }
  if (response.ok) return { ok: true, value: null };
  return { ok: false, error: response.status === 401 || response.status === 403
    ? { kind: "rejected" } : { kind: "unavailable", detail: `kbbl answered ${response.status}` } };
}

export const selectSignInFailureText = (failure: SignInFailure): string =>
  failure.kind === "rejected" ? "That token was not accepted." : `Could not reach kbbl: ${failure.detail}`;
