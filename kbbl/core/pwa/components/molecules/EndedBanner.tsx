import { useState, type Ref } from "react";

export function EndedBanner({
  ref,
  sid,
  onResume,
}: {
  ref?: Ref<HTMLDivElement>;
  sid: string;
  onResume: (parentSid: string) => Promise<string | null>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="session-ended-banner" ref={ref}>
      <div className="session-ended-text">
        Session ended · read-only transcript
      </div>
      <div className="session-ended-actions">
        <button
          type="button"
          className="btn-resume btn-resume-banner"
          disabled={pending}
          onClick={async () => {
            if (pending) return;
            setPending(true);
            setError(null);
            const err = await onResume(sid).catch((e) =>
              e instanceof Error ? e.message : "network error",
            );
            if (err) setError(err);
            setPending(false);
          }}
        >
          {pending ? "starting…" : "Resume in new session"}
        </button>
      </div>
      {error && (
        <div className="session-ended-error" role="alert">
          error: {error}
        </div>
      )}
    </div>
  );
}
