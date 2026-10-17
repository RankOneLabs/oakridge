/**
 * GET /auth/status: whether this kbbl requires a control credential, and
 * whether the request already carries a valid one in its cookie. The cookie
 * is HttpOnly, so the PWA cannot see it; only the server can say.
 */
export interface AuthStatus {
  readonly is_required: boolean;
  readonly is_authenticated: boolean;
}
