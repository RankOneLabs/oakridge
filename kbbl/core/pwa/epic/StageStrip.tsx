type EpicStage = "spec" | "plan" | "build" | "assess";
type SpecInternalStatus = "analyzing" | "discrepancies" | "review" | "approved";
type PlanStatus = "pending_approval" | "approved" | "rejected" | "superseded";

const STAGES: EpicStage[] = ["spec", "plan", "build", "assess"];

function stageRelation(
  stage: EpicStage,
  current: EpicStage,
): "done" | "current" | "upcoming" {
  const i = STAGES.indexOf(stage);
  const c = STAGES.indexOf(current);
  if (i < c) return "done";
  if (i === c) return "current";
  return "upcoming";
}

interface Cohort {
  status: string;
}

interface StageStripProps {
  current_stage: EpicStage;
  spec_internal_status: SpecInternalStatus | null;
  plan_status: PlanStatus | null;
  cohorts: Cohort[];
  assessment_present: boolean;
}

function buildStatusText(cohorts: Cohort[]): string {
  const done = cohorts.filter((c) => c.status === "done").length;
  return `${done} of ${cohorts.length} done`;
}

function tileStatusText(
  stage: EpicStage,
  spec_internal_status: SpecInternalStatus | null,
  plan_status: PlanStatus | null,
  cohorts: Cohort[],
  assessment_present: boolean,
): string {
  switch (stage) {
    case "spec":
      return spec_internal_status ?? "—";
    case "plan":
      return plan_status ?? "—";
    case "build":
      return buildStatusText(cohorts);
    case "assess":
      return assessment_present ? "done" : "pending";
  }
}

export function StageStrip({
  current_stage,
  spec_internal_status,
  plan_status,
  cohorts,
  assessment_present,
}: StageStripProps) {
  return (
    <div className="stage-strip" role="list" aria-label="Epic progression">
      {STAGES.map((stage) => {
        const rel = stageRelation(stage, current_stage);
        return (
          <div
            key={stage}
            role="listitem"
            className={`stage-strip__tile stage-strip__tile--${rel}`}
            aria-current={rel === "current" ? "step" : undefined}
          >
            <span className="stage-strip__tile-name">
              {stage.charAt(0).toUpperCase() + stage.slice(1)}
            </span>
            <span className="stage-strip__tile-status">
              {tileStatusText(
                stage,
                spec_internal_status,
                plan_status,
                cohorts,
                assessment_present,
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
