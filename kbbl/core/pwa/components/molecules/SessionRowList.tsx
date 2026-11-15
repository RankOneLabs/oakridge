import type { ReactNode } from "react";
import type { SessionSnapshot } from "../../types";
interface SessionRowListProps {
  sessions: SessionSnapshot[];
  renderRow: (session: SessionSnapshot) => ReactNode;
}

export function SessionRowList({ sessions, renderRow }: SessionRowListProps) {
  return (
    <ul className="session-list">
      {sessions.map(renderRow)}
    </ul>
  );
}

