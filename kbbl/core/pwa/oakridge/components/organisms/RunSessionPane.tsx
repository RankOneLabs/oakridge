import { useMemo, useRef } from "react";

import { useStore } from "../../../state/store";
import { resumeSession } from "../../../lib/session";
import { SessionView } from "../../../views/SessionView";
import type { SessionSurfaceLayout } from "../../../lib/session-surface";
import type { Sid } from "../../../lib/ids";

interface RunSessionPaneProps {
  sessionId: Sid;
  /**
   * Show `sessionId` in this same pane. Resume opens the new session here
   * rather than navigating, so the operator keeps their spatial context.
   */
  onOpenSession: (sessionId: Sid) => void;
}

/**
 * A live session inside a workspace pane.
 *
 * `SessionView` is reused whole — no session rendering is duplicated into the
 * Oakridge subtree. What this adds is the two things c1 made injectable: the
 * element the transcript scrolls (this pane's own container, so new output
 * follows down here and the rest of the workspace stays put) and the chrome
 * variant that drops the app-level back button and theme toggle, both of which
 * belong to the shell rather than to a pane.
 *
 * Session data comes from the zustand store through slice selectors rather
 * than down through OakridgeShell props: `App.tsx` calls `useInbox()`
 * unconditionally, above the route branch, so the store is populated under the
 * Oakridge route exactly as it is under `sid=`.
 */
export function RunSessionPane({ sessionId, onOpenSession }: RunSessionPaneProps) {
  const scrollHostRef = useRef<HTMLDivElement>(null);
  const sessions = useStore((state) => state.sessions);
  const inboxStatus = useStore((state) => state.inboxStatus);
  const hydrateSession = useStore((state) => state.hydrateSession);

  // Memoised for identity, not for cost: `useAutoScrollAndLayout` keys its
  // scroll listener on the layout's `scrollHost`, so a fresh object each
  // render would tear down and rebind that listener on every frame.
  const layout = useMemo<SessionSurfaceLayout>(
    () => ({
      scrollHost: { kind: "element", container: scrollHostRef },
      barAnchor: "surface",
    }),
    [],
  );

  return (
    <div
      className="or-run-pane-session"
      ref={scrollHostRef}
      data-testid="or-run-pane-session"
      data-session-id={sessionId}
    >
      <SessionView
        // Keyed by sid so switching the pane's session remounts the view
        // rather than carrying one transcript's scroll state into another.
        key={sessionId}
        sid={sessionId}
        snapshot={sessions.get(sessionId) ?? null}
        inboxStatus={inboxStatus}
        chrome={{ kind: "pane" }}
        layout={layout}
        onResume={(parentSid) =>
          resumeSession(parentSid, hydrateSession, (resumedSid) =>
            onOpenSession(resumedSid as Sid),
          )
        }
      />
    </div>
  );
}
