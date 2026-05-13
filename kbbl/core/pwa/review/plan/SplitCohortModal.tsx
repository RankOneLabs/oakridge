import { useState } from "react";
import { createPortal } from "react-dom";
import type { DependencyShape } from "./DagEditor";

export interface ResultCohortSpec {
  title: string;
  notes: string;
  priority: number;
}

export interface EdgeMigration {
  from: number;
  to: number;
  migrateTo: "result_0" | "result_1" | "delete";
}

interface Props {
  sourceIndex: number;
  incidentEdges: DependencyShape[];
  nextIndex: number;
  onConfirm: (specs: [ResultCohortSpec, ResultCohortSpec], migrations: EdgeMigration[]) => void;
  onClose: () => void;
}

export function SplitCohortModal({ sourceIndex, incidentEdges, nextIndex, onConfirm, onClose }: Props) {
  const [spec0, setSpec0] = useState<ResultCohortSpec>({ title: "", notes: "", priority: 0 });
  const [spec1, setSpec1] = useState<ResultCohortSpec>({ title: "", notes: "", priority: 0 });
  const [migrations, setMigrations] = useState<EdgeMigration[]>(
    incidentEdges.map((e) => ({ from: e.from_cohort_index, to: e.to_cohort_index, migrateTo: "result_0" })),
  );

  function updateMigration(idx: number, migrateTo: EdgeMigration["migrateTo"]) {
    setMigrations((prev) => prev.map((m, i) => i === idx ? { ...m, migrateTo } : m));
  }

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Split cohort #{sourceIndex}</h2>
        <p>Next available indices: #{sourceIndex} and #{nextIndex}</p>

        <h3>Result cohort A (#{sourceIndex})</h3>
        <CohortSpecForm spec={spec0} onChange={setSpec0} />

        <h3>Result cohort B (#{nextIndex})</h3>
        <CohortSpecForm spec={spec1} onChange={setSpec1} />

        {incidentEdges.length > 0 && (
          <>
            <h3>Edge migration</h3>
            {migrations.map((m, i) => (
              <div key={i} className="edge-migration-row">
                <span>{m.from} → {m.to}</span>
                <select value={m.migrateTo} onChange={(e) => updateMigration(i, e.target.value as EdgeMigration["migrateTo"])}>
                  <option value="result_0">→ cohort A (#{sourceIndex})</option>
                  <option value="result_1">→ cohort B (#{nextIndex})</option>
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
            disabled={!spec0.title.trim() || !spec1.title.trim()}
            onClick={() => onConfirm([spec0, spec1], migrations)}
          >
            split
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CohortSpecForm({ spec, onChange }: { spec: ResultCohortSpec; onChange: (s: ResultCohortSpec) => void }) {
  return (
    <div className="cohort-spec-form">
      <label>
        title
        <input type="text" value={spec.title} onChange={(e) => onChange({ ...spec, title: e.target.value })} />
      </label>
      <label>
        notes
        <textarea value={spec.notes} onChange={(e) => onChange({ ...spec, notes: e.target.value })} rows={3} />
      </label>
      <label>
        priority
        <input type="number" value={spec.priority} onChange={(e) => { const n = Number(e.target.value); if (!Number.isNaN(n)) onChange({ ...spec, priority: n }); }} />
      </label>
    </div>
  );
}
