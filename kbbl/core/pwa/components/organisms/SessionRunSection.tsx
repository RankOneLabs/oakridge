import type { SessionRunGroup } from "../../../acp/pwa-session-order";
import { useRun } from "../../oakridge/hooks/useRun";
import { SessionUnitHeading } from "../molecules/SessionUnitHeading";
import { SessionRowList } from "../molecules/SessionRowList";
import { SessionRow } from "./SessionRow";
import { selectSessionStageName } from "../../lib/session";
interface SessionRunSectionProps {
  run: SessionRunGroup;
  title: string | null;
  onSelect: (sid: string) => void;
  onResume: (sid: string) => void;
  resumeDisabled: boolean;
}

export function SessionRunSection({
  run,
  title,
  onSelect,
  onResume,
  resumeDisabled,
}: SessionRunSectionProps) {
  const runQuery = useRun(run.runId);

  return (
    <section
      className="session-run-group"
      data-testid={`session-run-${run.runId}`}
    >
      <h2 className="session-cohort-heading session-cohort-heading--plain">
        {title ?? run.runId}
      </h2>
      {run.units.map((group) => (
        <section key={group.key} className="session-cohort-group">
          <SessionUnitHeading title={selectSessionStageName(group.unitId, runQuery.data) ?? group.unitId} />
          <SessionRowList
            sessions={group.sessions}
            renderRow={(s) => <SessionRow key={s.sid} snapshot={s} onOpen={() => onSelect(s.sid)} onResume={() => onResume(s.sid)} resumeDisabled={resumeDisabled} />}
          />
        </section>
      ))}
    </section>
  );
}

