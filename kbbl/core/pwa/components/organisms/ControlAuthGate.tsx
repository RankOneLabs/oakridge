import { useState, type ReactNode } from "react";
import { useControlAuth } from "../../hooks/useControlAuth";
import { selectIsSignInRequired, selectSignInFailureText } from "../../lib/control-auth";
import { Button } from "../atoms/Button";
import { FeedbackMessage } from "../atoms/FeedbackMessage";

interface ControlAuthGateProps {
  children: ReactNode;
}

/**
 * Holds the app back until the browser carries kbbl's control credential,
 * when kbbl requires one: without it every write and every Oakridge operator
 * read is refused. The token is exchanged once for an HttpOnly cookie.
 */
export function ControlAuthGate({ children }: ControlAuthGateProps) {
  const auth = useControlAuth();
  const [token, setToken] = useState("");
  if (auth.is_loading) return null;
  // Without kbbl's answer the gate cannot tell whether a token is needed: it stays closed rather than open onto refused requests.
  if (auth.status_error !== null) return (
    <main className="mx-auto mt-24 flex max-w-sm flex-col gap-4 px-4" data-testid="control-auth-unavailable">
      <FeedbackMessage tone="danger">Could not reach kbbl to check sign-in: {auth.status_error.message}</FeedbackMessage>
      <Button variant="secondary" size="medium" onClick={auth.retryStatus}>Retry</Button>
    </main>
  );
  if (!selectIsSignInRequired(auth.status)) return <>{children}</>;
  return (
    <main className="mx-auto mt-24 flex max-w-sm flex-col gap-4 px-4" data-testid="control-sign-in">
      <h1 className="text-lg font-semibold text-[var(--text-primary)]">Sign in to kbbl</h1>
      <p className="text-sm text-[var(--text-muted)]">Enter the control token this kbbl was started with (OAKRIDGE_CONTROL_TOKEN).</p>
      <form className="flex flex-col gap-3" onSubmit={(event) => {
        event.preventDefault();
        if (token.trim() !== "") auth.signIn(token.trim());
      }}>
        <input type="password" autoComplete="current-password" aria-label="Control token" value={token} disabled={auth.is_signing_in}
          className="rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-2 text-sm text-[var(--text-primary)]"
          onChange={(event) => setToken(event.target.value)} />
        <Button type="submit" variant="primary" size="medium" disabled={auth.is_signing_in || token.trim() === ""}>Sign in</Button>
      </form>
      {auth.failure && <FeedbackMessage tone="danger" testId="control-sign-in-failure">{selectSignInFailureText(auth.failure)}</FeedbackMessage>}
    </main>
  );
}
