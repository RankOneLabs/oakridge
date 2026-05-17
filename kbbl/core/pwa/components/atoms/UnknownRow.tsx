import type { EnvelopeEvent } from "../../types";

export function UnknownRow({
  event,
  compact,
}: {
  event: EnvelopeEvent;
  compact: boolean;
}) {
  return (
    <div className="row row-system" title={`event #${event.id}`}>
      <div className="notice notice-muted">
        {!compact && <span className="notice-tag">#{event.id}</span>}
        unknown type={event.type}
      </div>
    </div>
  );
}
