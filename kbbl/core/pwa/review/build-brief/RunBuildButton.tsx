import { useState } from "react";
import { useBuildLifecycleStream } from "./useBuildLifecycleStream";

interface BuildRun {
  id: string;
  phases: Array<{ phase_index: number }>;
}

interface Props {
  briefId: string;
  run: BuildRun | null;
  status: string | null;
}

export function RunBuildButton({ briefId, run, status }: Props) {
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const lifecycleStream = useBuildLifecycleStream(briefId);
  const buildStatus = lifecycleStream.status;

  // Only show when approved and no phase_index=1 yet
  const alreadyStarted = run?.phases.some((p) => p.phase_index === 1) ?? false;
  if (status !== "approved") return null;
  if (alreadyStarted && buildStatus === "idle") {
    return <span className="run-build-already-started">Build already started</span>;
  }

  async function handleRunBuild() {
    setTriggering(true);
    setTriggerError(null);
    try {
      const res = await fetch(
        `/safir-proxy/build-briefs/${encodeURIComponent(briefId)}/build`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setTriggerError(b.message ?? b.error ?? `HTTP ${res.status}`);
      }
    } finally {
      setTriggering(false);
    }
  }

  if (buildStatus === "building") {
    return <span className="run-build-status run-build-status--building">Building…</span>;
  }

  if (buildStatus === "completed") {
    return (
      <span className="run-build-status run-build-status--completed">
        Build complete — see debrief
      </span>
    );
  }

  if (buildStatus === "failed") {
    return (
      <div className="run-build-failed">
        <span className="run-build-status run-build-status--failed">Build failed</span>
        {lifecycleStream.stderrTail && (
          <pre className="run-build-stderr">{lifecycleStream.stderrTail}</pre>
        )}
        <button
          type="button"
          className="run-build-btn"
          onClick={() => void handleRunBuild()}
          disabled={triggering}
        >
          {triggering ? "triggering…" : "Retry build"}
        </button>
      </div>
    );
  }

  return (
    <div className="run-build-container">
      {triggerError && (
        <span className="run-build-trigger-error">{triggerError}</span>
      )}
      <button
        type="button"
        className="run-build-btn"
        onClick={() => void handleRunBuild()}
        disabled={triggering}
      >
        {triggering ? "triggering…" : "Run build"}
      </button>
    </div>
  );
}
