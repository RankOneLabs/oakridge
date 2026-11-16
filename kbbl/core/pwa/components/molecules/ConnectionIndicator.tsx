import type { Status } from "../../types";

const CONNECTION_COPY: Record<Status, { label: string; description: string }> = {
  connecting: { label: "Connecting", description: "Connecting — opening the live update stream." },
  connected: { label: "Connected", description: "Connected — receiving live updates." },
  disconnected: { label: "Disconnected", description: "Disconnected — not receiving live updates." },
  stale: { label: "Stale", description: "Stale — no update received recently; what you see may be out of date." },
};

export function ConnectionIndicator({ status }: { status: Status }) {
  const { label, description } = CONNECTION_COPY[status];
  return <span role="status" aria-label={`Connection: ${label}`} title={description}
    className={`connection-indicator status p-0! rounded-none! bg-transparent! status-${status}`} data-testid="session-connection-indicator" data-status={status}>
    <span aria-hidden="true">●</span><span className="sr-only">{label}</span>
  </span>;
}
