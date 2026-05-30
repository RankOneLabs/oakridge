import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { responseError } from "../lib/http";

type DiscrepancyStatus = "open" | "resolved" | "waived";
type SpecInternalStatus = "analyzing" | "discrepancies" | "review" | "approved";

interface Discrepancy {
  id: string;
  spec_assumption: string;
  code_reality: string;
  status: DiscrepancyStatus;
  resolution: string | null;
}

interface DiscrepanciesEditorProps {
  spec_id: string;
  epic_id: string;
  internal_status: SpecInternalStatus;
}

interface RowProps {
  row: Discrepancy;
  onResolve: (id: string, resolution: string) => void;
  onWaive: (id: string, resolution: string) => void;
  isPending: boolean;
}

function DiscrepancyRow({ row, onResolve, onWaive, isPending }: RowProps) {
  const [resolution, setResolution] = useState("");

  if (row.status !== "open") {
    return (
      <tr className={`discrepancy-row discrepancy-row--${row.status}`}>
        <td className="discrepancy-row__assumption">{row.spec_assumption}</td>
        <td className="discrepancy-row__reality">{row.code_reality}</td>
        <td>
          <span className={`discrepancy-row__chip discrepancy-row__chip--${row.status}`}>
            {row.status}
          </span>
        </td>
        <td className="discrepancy-row__resolution">{row.resolution}</td>
        <td />
      </tr>
    );
  }

  const trimmed = resolution.trim();
  return (
    <tr className="discrepancy-row discrepancy-row--open">
      <td className="discrepancy-row__assumption">{row.spec_assumption}</td>
      <td className="discrepancy-row__reality">{row.code_reality}</td>
      <td>
        <span className="discrepancy-row__chip discrepancy-row__chip--open">open</span>
      </td>
      <td>
        <input
          type="text"
          className="discrepancy-row__input"
          placeholder="Resolution note…"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          disabled={isPending}
        />
      </td>
      <td className="discrepancy-row__btns">
        <button
          type="button"
          className="discrepancy-row__btn"
          disabled={isPending || trimmed === ""}
          onClick={() => onResolve(row.id, trimmed)}
        >
          Resolve
        </button>
        <button
          type="button"
          className="discrepancy-row__btn"
          disabled={isPending || trimmed === ""}
          onClick={() => onWaive(row.id, trimmed)}
        >
          Waive
        </button>
      </td>
    </tr>
  );
}

export function DiscrepanciesEditor({
  spec_id,
  epic_id,
  internal_status,
}: DiscrepanciesEditorProps) {
  const queryClient = useQueryClient();
  const [confirmingApprove, setConfirmingApprove] = useState(false);

  const discQuery = useQuery({
    queryKey: ["discrepancies", spec_id],
    queryFn: async (): Promise<Discrepancy[]> => {
      const res = await fetch(`/spec-discrepancies?spec_id=${encodeURIComponent(spec_id)}`);
      if (!res.ok) throw await responseError(res, "discrepancies");
      return (await res.json()) as Discrepancy[];
    },
  });

  const patchMutation = useMutation({
    mutationFn: async ({
      discId,
      resolution,
      status,
    }: {
      discId: string;
      resolution: string;
      status: "resolved" | "waived";
    }) => {
      const res = await fetch(`/spec-discrepancies/${encodeURIComponent(discId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolution, status }),
      });
      if (!res.ok) throw await responseError(res, "patch");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["discrepancies", spec_id] });
    },
  });

  const transitionMutation = useMutation({
    mutationFn: async (targetStatus: "review" | "approved") => {
      const res = await fetch(
        `/specs/${encodeURIComponent(spec_id)}/internal-status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ internal_status: targetStatus }),
        },
      );
      if (!res.ok) throw await responseError(res, "transition");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["epic", epic_id] });
    },
  });

  if (discQuery.error instanceof Error) {
    return (
      <div className="discrepancies-editor__error" role="alert">
        {discQuery.error.message}
      </div>
    );
  }

  if (discQuery.isPending) {
    return <div className="discrepancies-editor__loading">Loading discrepancies…</div>;
  }

  const rows = discQuery.data ?? [];
  const countOpen = rows.filter((r) => r.status === "open").length;
  const patchErr =
    patchMutation.error instanceof Error ? patchMutation.error.message : null;
  const transitionErr =
    transitionMutation.error instanceof Error
      ? transitionMutation.error.message
      : null;

  // The action offered in the footer depends on the spec's current
  // internal_status. Driving it off status (rather than a fixed
  // "Move to Review") keeps the button in sync after a transition —
  // otherwise a second click re-sends the same transition and the
  // state machine rejects it with a 409. analyzing/approved expose no
  // action (the editor unmounts once the epic leaves the spec stage).
  const action =
    internal_status === "discrepancies"
      ? {
          label: "Move to Review",
          target: "review" as const,
          disabled: countOpen > 0,
          confirm: false,
        }
      : internal_status === "review"
        ? {
            label: "Approve & start planning",
            target: "approved" as const,
            disabled: false,
            confirm: true,
          }
        : null;

  return (
    <div className="discrepancies-editor">
      <h2 className="discrepancies-editor__heading">Discrepancies</h2>
      {rows.length === 0 ? (
        <div className="discrepancies-editor__empty">No discrepancies found.</div>
      ) : (
        <table className="discrepancies-editor__table">
          <thead>
            <tr>
              <th>Spec assumption</th>
              <th>Code reality</th>
              <th>Status</th>
              <th>Resolution</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <DiscrepancyRow
                key={row.id}
                row={row}
                isPending={patchMutation.isPending}
                onResolve={(id, res) =>
                  patchMutation.mutate({ discId: id, resolution: res, status: "resolved" })
                }
                onWaive={(id, res) =>
                  patchMutation.mutate({ discId: id, resolution: res, status: "waived" })
                }
              />
            ))}
          </tbody>
        </table>
      )}
      {patchErr && (
        <div className="discrepancies-editor__error" role="alert">
          {patchErr}
        </div>
      )}
      {transitionErr && (
        <div className="discrepancies-editor__error" role="alert">
          {transitionErr}
        </div>
      )}
      <div className="discrepancies-editor__footer">
        {action && !(action.confirm && confirmingApprove) && (
          <button
            type="button"
            className="discrepancies-editor__move-btn"
            disabled={action.disabled || transitionMutation.isPending}
            onClick={() =>
              action.confirm
                ? setConfirmingApprove(true)
                : transitionMutation.mutate(action.target)
            }
          >
            {action.label}
          </button>
        )}
        {action?.confirm && confirmingApprove && (
          <span className="discrepancies-editor__confirm">
            Approve this spec? This dispatches the plan writer.
            <button
              type="button"
              className="discrepancies-editor__move-btn"
              disabled={transitionMutation.isPending}
              onClick={() => transitionMutation.mutate(action.target)}
            >
              Confirm
            </button>
            <button
              type="button"
              className="discrepancy-row__btn"
              disabled={transitionMutation.isPending}
              onClick={() => setConfirmingApprove(false)}
            >
              Cancel
            </button>
          </span>
        )}
        {internal_status === "discrepancies" && countOpen > 0 && (
          <span className="discrepancies-editor__open-count">
            {countOpen} open discrepanc{countOpen === 1 ? "y" : "ies"} remaining
          </span>
        )}
      </div>
    </div>
  );
}
