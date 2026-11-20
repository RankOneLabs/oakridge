import { useElapsedSeconds } from "../../hooks/useElapsedSeconds";
import { operatorStateLabel } from "../../lib/operator-state";
import {
  selectActiveTool, selectElapsedStartMs, selectLatestAgentLine, selectPanelExecution,
  selectPanelPermissions, selectPlanProgress, selectQueuedTurns, selectRunningTurn, selectUsageLabel,
} from "../../lib/session-panel";
import { useSessionTranscript } from "../../state/session-transcript-store";
import type { PendingSend, SessionSnapshot } from "../../types";
import { StatusRow } from "../atoms/StatusRow";
import { ThinkingIndicator } from "../atoms/ThinkingIndicator";
import { PermissionCard } from "./PermissionCard";

interface AgentStatusPanelProps {
  sid: string;
  snapshot: SessionSnapshot | null;
  pendingSends: readonly PendingSend[];
  isInterrupting: boolean;
  localWaitStartedMs: number | null;
  sessionClosed: boolean;
}

export function AgentStatusPanel({
  sid, snapshot, pendingSends, isInterrupting, localWaitStartedMs, sessionClosed,
}: AgentStatusPanelProps) {
  const transcript = useSessionTranscript(sid, (state) => state);
  const execution = selectPanelExecution({
    transcript, snapshot, pending_sends: pendingSends, is_interrupting: isInterrupting,
  });
  const isElapsedActive = execution.kind !== "idle" && execution.kind !== "ended"
    && execution.kind !== "failed" && execution.kind !== "fenced";
  const elapsedSec = useElapsedSeconds(selectElapsedStartMs(transcript, localWaitStartedMs), isElapsedActive);
  const runningText = selectRunningTurn(transcript)?.text ?? null;
  const latest = selectLatestAgentLine(transcript);
  const tool = selectActiveTool(transcript);
  const plan = selectPlanProgress(transcript);
  const permissions = selectPanelPermissions(transcript);
  const queue = selectQueuedTurns(transcript);
  const usage = selectUsageLabel(transcript.session_state.usage);

  return (
    <section className="agent-status-panel" aria-label="Agent status">
      <ThinkingIndicator
        label={operatorStateLabel(execution)}
        elapsedSec={isElapsedActive ? elapsedSec : null}
        outputTokens={null}
      />
      {runningText !== null && <StatusRow label="running" title={runningText}>{runningText}</StatusRow>}
      {latest !== null && <StatusRow label="latest">{latest}</StatusRow>}
      {tool !== null && <StatusRow label="tool">{tool.title} · {tool.kind}</StatusRow>}
      {plan !== null && (
        <StatusRow label="plan">
          {plan.completed}/{plan.total}{plan.current_entry !== null && ` · ${plan.current_entry}`}
        </StatusRow>
      )}
      {permissions.map((item) => (
        <PermissionCard
          key={item.key}
          sid={sid}
          requestId={item.requestId}
          title={item.title}
          options={item.options}
          resolution={item.resolution}
          sessionClosed={sessionClosed}
        />
      ))}
      {queue.length > 0 && (
        <StatusRow label="queued">
          {queue.map((turn) => (
            <div className="status-row__value" key={turn.turnKey} title={turn.text}>{turn.text}</div>
          ))}
        </StatusRow>
      )}
      {usage !== null && <StatusRow label="context">{usage}</StatusRow>}
    </section>
  );
}
