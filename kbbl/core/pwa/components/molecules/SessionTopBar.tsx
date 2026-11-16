import { ConnectionIndicator } from "./ConnectionIndicator";
import { Button } from "../atoms/Button";
import type { Ref } from "react";

import type { SessionSnapshot, Status } from "../../types";
import type { UsageState } from "../../lib/acp-timeline";
import type { SessionSurfaceChrome } from "../../lib/session-surface";
import { formatTokens, prettyEffortLabel, prettyModelLabel } from "../../lib/format";
import { selectSessionHeaderSegments, sessionLabelTitle, workdirBasename } from "../../lib/session";

function usageLabel(usage: UsageState): string | null {
  if (usage.used === null) return null;
  const used = formatTokens(usage.used);
  return usage.size !== null ? `${used}/${formatTokens(usage.size)}` : used;
}

export function SessionTopBar({
  ref,
  sid,
  snapshot,
  streamStatus,
  inboxStatus,
  usage,
  chrome,
}: {
  ref?: Ref<HTMLElement>;
  sid: string;
  snapshot: SessionSnapshot | null;
  streamStatus: Status;
  inboxStatus: Status;
  usage: UsageState | null;
  /**
   * What the host contributes. Session identity — sid, status, stream status,
   * usage — is the bar's own and renders for both; back belongs to the route
   * host alone.
   */
  chrome: SessionSurfaceChrome;
}) {
  const isOpen =
    snapshot !== null &&
    snapshot.status !== "ended" &&
    snapshot.status !== "fenced" &&
    snapshot.status !== "failed";
  // Show stream status on an open session, inbox status otherwise —
  // stream status on a closed session's view is misleading.
  const shownStatus = isOpen ? streamStatus : inboxStatus;
  const segments = selectSessionHeaderSegments({ snapshot, chrome });
  const usageText = usage !== null ? usageLabel(usage) : null;

  return (
    <header className="top-bar" ref={ref} data-chrome={chrome.kind}>
      {chrome.kind === "route" && (
        <Button variant="session"
          type="button"
          className="back-button"
          onClick={chrome.onBack}
          aria-label="Back to session list"
          title="Back to session list"
        >
          ←
        </Button>
      )}
      <ConnectionIndicator status={shownStatus} />
      {usageText !== null && (
        <span
          className="event-count"
          title={
            usage?.cost
              ? `context used · cost ${usage.cost.amount} ${usage.cost.currency}`
              : "context used"
          }
        >
          {usageText}
        </span>
      )}
      <span
        className="session-label"
        title={snapshot ? sessionLabelTitle(snapshot, sid) : `session ${sid}`}
      >
        <span className="session-label-name">
          {snapshot?.name || sid.slice(0, 8)}
        </span>
        {snapshot?.agentProfile && (
          <span className="session-label-model" title={`agent: ${snapshot.agentProfile}`}>
            {snapshot.agentProfile}
          </span>
        )}
        {snapshot?.requestedModel && (
          <span
            className="session-label-model"
            title={`requested: ${snapshot.requestedModel}`}
          >
            {prettyModelLabel(snapshot.requestedModel)}
          </span>
        )}
        {snapshot?.requestedEffort && (
          <span
            className="session-label-effort"
            title={`effort: ${snapshot.requestedEffort}`}
          >
            effort {prettyEffortLabel(snapshot.requestedEffort)}
          </span>
        )}
        {snapshot && (
          <span className="session-label-workdir">
            {workdirBasename(snapshot.projectWorkdir)}
          </span>
        )}
        <span className="flex min-w-0 max-w-full items-center gap-1">
          {segments.role && <strong className="session-role" data-testid="session-role">{segments.role}</strong>}
          {segments.stage && <>{segments.role && <span aria-hidden="true">·</span>}<span className="session-stage" data-testid="session-stage">{segments.stage}</span></>}
          {segments.branch && <>{(segments.role || segments.stage) && <span aria-hidden="true">·</span>}<span className="session-branch truncate" data-testid="session-branch" title={segments.branch}>{segments.branch}</span></>}
        </span>
      </span>
    </header>
  );
}
