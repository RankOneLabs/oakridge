import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

type DiscrepancyStatus = "open" | "resolved" | "waived";

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

export function DiscrepanciesEditor({ spec_id, epic_id }: DiscrepanciesEditorProps) {
  const queryClient = useQueryClient();

  const discQuery = useQuery({
    queryKey: ["discrepancies", spec_id],
    queryFn: async (): Promise<Discrepancy[]> => {
      const res = await fetch(`/spec-discrepancies?spec_id=${encodeURIComponent(spec_id)}`);
      if (!res.ok) throw new Error(`discrepancies: ${res.status}`);
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
      if (!res.ok) throw new Error(`patch: ${res.status}`);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["discrepancies", spec_id] });
    },
  });

  const moveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `/specs/${encodeURIComponent(spec_id)}/internal-status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ internal_status: "review" }),
        },
      );
      if (!res.ok) throw new Error(`move: ${res.status}`);
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
  const moveErr =
    moveMutation.error instanceof Error ? moveMutation.error.message : null;

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
      {moveErr && (
        <div className="discrepancies-editor__error" role="alert">
          {moveErr}
        </div>
      )}
      <div className="discrepancies-editor__footer">
        <button
          type="button"
          className="discrepancies-editor__move-btn"
          disabled={countOpen > 0 || moveMutation.isPending}
          onClick={() => moveMutation.mutate()}
        >
          Move to Review
        </button>
        {countOpen > 0 && (
          <span className="discrepancies-editor__open-count">
            {countOpen} open discrepanc{countOpen === 1 ? "y" : "ies"} remaining
          </span>
        )}
      </div>
    </div>
  );
}
