import { Button } from "../atoms/Button";

interface CompactControlProps {
  isPending: boolean;
  error: string | null;
  onCompact: () => void;
}

/** Persistent operator action composed from the shared button atom. */
export function CompactControl({
  isPending,
  error,
  onCompact,
}: CompactControlProps) {
  return (
    <div className="compact-control">
      {error !== null && (
        <span className="compact-control__error" role="alert">
          Compact failed: {error}
        </span>
      )}
      <Button
        className="compact-control__action"
        disabled={isPending}
        onClick={onCompact}
      >
        {isPending ? "Compacting…" : "Compact"}
      </Button>
    </div>
  );
}
