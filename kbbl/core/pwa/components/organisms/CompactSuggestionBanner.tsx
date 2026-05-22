import { useCompactRequest } from "../../hooks/useCompactRequest";

export function CompactSuggestionBanner({
  sid,
  tokens,
  onClear,
}: {
  sid: string;
  tokens: number;
  onClear: () => void;
}) {
  const { trigger } = useCompactRequest(sid, onClear);
  return (
    <div className="compact-suggestion-banner">
      <span className="compact-suggestion-banner__text">
        Session is at {tokens.toLocaleString()} tokens — approaching the context limit.
      </span>
      <button
        type="button"
        className="compact-suggestion-banner__action"
        onClick={() => void trigger()}
      >
        Compact Now
      </button>
      <button
        type="button"
        className="compact-suggestion-banner__dismiss"
        onClick={onClear}
      >
        Dismiss
      </button>
    </div>
  );
}
