import { useState } from "react";

export function useResumeAction(
  onResume: (parentSid: string) => Promise<string | null>,
): {
  trigger: (sid: string) => Promise<void>;
  pending: boolean;
  error: string | null;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function trigger(sid: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    const err = await onResume(sid).catch((e) =>
      e instanceof Error ? e.message : "network error",
    );
    if (err) setError(err);
    setPending(false);
  }

  return { trigger, pending, error };
}
