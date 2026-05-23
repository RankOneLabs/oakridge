import { useState, type Ref } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import type { SessionSnapshot, Status, Theme } from "../../types";
import { prettyModelLabel } from "../../lib/format";
import { responseError } from "../../lib/http";
import { sessionLabelTitle, workdirBasename } from "../../lib/session";

export function SessionTopBar({
  ref,
  sid,
  snapshot,
  streamStatus,
  inboxStatus,
  eventCount,
  yoloMode,
  theme,
  showSystemEvents,
  softThresholdTokens,
  thresholdInput,
  onThresholdChange,
  onToggleSystemEvents,
  onToggleTheme,
  onBack,
}: {
  ref?: Ref<HTMLElement>;
  sid: string;
  snapshot: SessionSnapshot | null;
  streamStatus: Status;
  inboxStatus: Status;
  eventCount: number;
  yoloMode: boolean;
  theme: Theme;
  showSystemEvents: boolean;
  softThresholdTokens: number;
  thresholdInput: string;
  onThresholdChange: (n: number, input: string) => void;
  onToggleSystemEvents: () => void;
  onToggleTheme: () => void;
  onBack: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const canToggleYolo = snapshot?.status === "live";

  const yoloMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch(`/${encodeURIComponent(sid)}/yolo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    },
  });

  const thresholdMutation = useMutation({
    mutationFn: async (n: number) => {
      const res = await fetch("/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ softThresholdTokens: n }),
      });
      if (!res.ok) throw await responseError(res, "threshold update");
    },
    onSuccess: () => {
      // /config drives useServerConfig; invalidate so the next mount reflects
      // the new threshold rather than the staleTime=Infinity cached value.
      void queryClient.invalidateQueries({ queryKey: ["config"] });
    },
  });

  async function toggleYolo() {
    if (yoloMutation.isPending || !canToggleYolo) return;
    setError(null);
    try {
      await yoloMutation.mutateAsync(!yoloMode);
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    }
  }

  // Show stream status when on a live session, inbox status otherwise —
  // stream status on an archived-only view is misleading ("disconnected"
  // just means the one-shot fetch finished).
  const shownStatus = snapshot?.status === "live" ? streamStatus : inboxStatus;
  return (
    <header className="top-bar" ref={ref}>
      <button
        type="button"
        className="back-button"
        onClick={onBack}
        aria-label="Back to session list"
        title="Back to session list"
      >
        ←
      </button>
      <span className={`status status-${shownStatus}`}>{shownStatus}</span>
      <span className="event-count">{eventCount} events</span>
      <button
        type="button"
        className={`theme-toggle ${showSystemEvents ? "is-on" : ""}`}
        onClick={onToggleSystemEvents}
        title={
          showSystemEvents
            ? "Hide hook lifecycle and other low-signal system events"
            : "Show hook lifecycle and other low-signal system events"
        }
        aria-pressed={showSystemEvents}
        aria-label="Toggle system events visibility"
      >
        SYS
      </button>
      <button
        type="button"
        className="theme-toggle"
        onClick={onToggleTheme}
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        aria-label={
          theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
        }
      >
        {theme === "dark" ? "LIGHT" : "DARK"}
      </button>
      <button
        type="button"
        className={`yolo-toggle ${yoloMode ? "is-on" : ""}`}
        onClick={() => void toggleYolo()}
        disabled={yoloMutation.isPending || !canToggleYolo}
        title={
          !canToggleYolo
            ? "YOLO only toggleable while the session is live"
            : yoloMode
              ? "YOLO mode on — every tool call auto-approves"
              : "Tap to enable YOLO mode (auto-approve every tool call)"
        }
        aria-pressed={yoloMode}
      >
        {yoloMode ? "YOLO ON" : "YOLO"}
      </button>
      {error && (
        <span className="yolo-error" title={error} role="alert">
          ⚠ {error}
        </span>
      )}
      <span
        className="session-label"
        title={
          snapshot
            ? sessionLabelTitle(snapshot, sid)
            : `session ${sid}`
        }
      >
        <span className="session-label-name">
          {snapshot?.name || sid.slice(0, 8)}
        </span>
        {snapshot?.model && (
          <span className="session-label-model" title={snapshot.model}>
            {prettyModelLabel(snapshot.model)}
          </span>
        )}
        {snapshot && (() => {
          // projectWorkdir is the operator's original repo when worktrees
          // are on; falls back to workdir for pre-Phase-1 archived
          // sessions where projectWorkdir is null.
          const project = snapshot.projectWorkdir ?? snapshot.workdir;
          if (!project) return null;
          // worktreeBranch slug — strip the kbbl/ prefix and show what's
          // left ("abc12345" or "abc12345-r1") next to the project basename
          // so the operator can tell at a glance which branch this
          // session's edits land on.
          const slug = snapshot.worktreeBranch
            ? snapshot.worktreeBranch.replace(/^kbbl\//, "")
            : null;
          return (
            <span className="session-label-workdir">
              {workdirBasename(project)}
              {slug && <span className="session-label-slug"> › {slug}</span>}
            </span>
          );
        })()}
      </span>
      <label className="threshold-setting" title="Compact suggestion threshold (tokens)">
        <span className="threshold-setting__label">Compact at</span>
        <input
          type="number"
          className="threshold-setting__input"
          value={thresholdInput}
          min={1000}
          step={1000}
          onChange={(e) => onThresholdChange(softThresholdTokens, e.target.value)}
          onBlur={async () => {
            const n = Number(thresholdInput);
            if (!Number.isInteger(n) || n < 1000) {
              onThresholdChange(softThresholdTokens, String(softThresholdTokens));
              return;
            }
            try {
              await thresholdMutation.mutateAsync(n);
              onThresholdChange(n, String(n));
            } catch {
              // Roll back to the previously-accepted value so the operator
              // doesn't end up looking at a number the server rejected.
              onThresholdChange(softThresholdTokens, String(softThresholdTokens));
            }
          }}
        />
        <span className="threshold-setting__unit">tok</span>
      </label>
    </header>
  );
}
