import { type Ref } from "react";

import { useResumeAction } from "../../hooks/useResumeAction";
import { Button } from "../atoms/Button";

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
        <Button
          type="button"
          variant="primary"
          className="!px-5 !py-[0.6rem] !text-[0.9rem]"
          disabled={pending}
          onClick={() => void trigger(sid)}
        >
          {pending ? "starting…" : "Resume in new session"}
        </Button>
      </div>
      {error && (
        <div className="session-ended-error" role="alert">
          error: {error}
        </div>
      )}
    </div>
  );
}
