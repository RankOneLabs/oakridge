type PlanStatus = "pending_approval" | "approved" | "rejected" | "superseded";

interface Plan {
  id: string;
  status: PlanStatus;
}

interface PlanDrilldownProps {
  plan: Plan;
}

export function PlanDrilldown({ plan }: PlanDrilldownProps) {
  return (
    <div className="plan-drilldown">
      <h2 className="plan-drilldown__heading">Plan</h2>
      <div className="plan-drilldown__row">
        <a
          href={`#plan/${plan.id}`}
          className="plan-drilldown__link"
          onClick={(e) => {
            e.preventDefault();
            window.location.hash = `plan/${plan.id}`;
          }}
        >
          View plan
        </a>
      </div>
    </div>
  );
}
