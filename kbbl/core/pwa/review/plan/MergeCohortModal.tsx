import { useState } from "react";
import { createPortal } from "react-dom";
import type { ResultCohortSpec, EdgeMigration } from "./SplitCohortModal";
import type { DependencyShape } from "./DagEditor";

interface Props {
  selectedIndices: number[];
  incidentEdges: DependencyShape[];
  nextIndex: number;
  onConfirm: (spec: ResultCohortSpec, migrations: EdgeMigration[]) => void;
  onClose: () => void;
}

export function MergeCohortModal({ selectedIndices, incidentEdges, nextIndex, onConfirm, onClose }: Props) {
  const [spec, setSpec] = useState<ResultCohortSpec>({ title: "", notes: "", priority: 0 });
  const [migrations, setMigrations] = useState<EdgeMigration[]>(
    incidentEdges
      .filter((e) => !selectedIndices.includes(e.from_cohort_index) || !selectedIndices.includes(e.to_cohort_index))
      .map((e) => ({ from: e.from_cohort_index, to: e.to_cohort_index, migrateTo: "result_0" })),
  );

  function updateMigration(idx: number, migrateTo: EdgeMigration["migrateTo"]) {
    setMigrations((prev) => prev.map((m, i) => i === idx ? { ...m, migrateTo } : m));
  }

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Merge cohorts #{selectedIndices.join(", #")}</h2>
        <p>Result cohort index: #{nextIndex}</p>

        <h3>Merged cohort spec</h3>
        <div className="cohort-spec-form">
          <label>
            title
            <input type="text" value={spec.title} onChange={(e) => setSpec({ ...spec, title: e.target.value })} />
          </label>
          <label>
            notes
            <textarea value={spec.notes} onChange={(e) => setSpec({ ...spec, notes: e.target.value })} rows={3} />
          </label>
          <label>
            priority
            <input type="number" value={spec.priority} onChange={(e) => setSpec({ ...spec, priority: Number(e.target.value) })} />
          </label>
        </div>

        {migrations.length > 0 && (
          <>
            <h3>Edge migration</h3>
            {migrations.map((m, i) => (
              <div key={i} className="edge-migration-row">
                <span>{m.from} → {m.to}</span>
                <select value={m.migrateTo} onChange={(e) => updateMigration(i, e.target.value as EdgeMigration["migrateTo"])}>
                  <option value="result_0">→ merged cohort (#{nextIndex})</option>
                  <option value="delete">delete</option>
                </select>
              </div>
            ))}
          </>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>cancel</button>
          <button
            type="button"
            className="modal-confirm"
            disabled={!spec.title.trim()}
            onClick={() => onConfirm(spec, migrations)}
          >
            merge
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
