import { type Ref } from "react";

import { useResumeAction } from "../../hooks/useResumeAction";

export function EndedBanner({
  ref,
  sid,
  onResume,
}: {
  ref?: Ref<HTMLDivElement>;
  sid: string;
  onResume: (parentSid: string) => Promise<string | null>;
}) {
  const { trigger, pending, error } = useResumeAction(onResume);
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
          onClick={() => void trigger(sid)}
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
