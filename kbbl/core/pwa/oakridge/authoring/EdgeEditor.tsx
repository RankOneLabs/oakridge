import type { EdgeDef } from "../../oakridge/types";

const inputClass =
  "rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-3 py-1.5 text-sm text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none";
const dangerBtnClass =
  "rounded border border-red-400 px-2 py-0.5 text-xs text-red-400 hover:bg-red-400 hover:text-white";
const addBtnClass =
  "rounded border border-[var(--border-muted)] px-2 py-0.5 text-xs text-[var(--text-secondary)] hover:border-[var(--border-hover)]";
const labelClass = "block text-xs font-medium text-[var(--text-muted)] mb-0.5";

function defaultEdge(): EdgeDef {
  return { from: { stage: "", slot: "" }, to: { stage: "", slot: "" } };
}

interface EdgeEditorProps {
  edges: EdgeDef[];
  stageKeys: string[];
  onChange: (edges: EdgeDef[]) => void;
  disabled?: boolean;
}

export function EdgeEditor({ edges, stageKeys, onChange, disabled = false }: EdgeEditorProps) {
  const addEdge = () => onChange([...edges, defaultEdge()]);
  const removeEdge = (i: number) => onChange(edges.filter((_, idx) => idx !== i));
  const updateEdge = (i: number, patch: Partial<EdgeDef>) =>
    onChange(edges.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase text-[var(--text-muted)]">Edges</span>
        <button type="button" className={addBtnClass} onClick={addEdge} disabled={disabled}>
          + Add edge
        </button>
      </div>

      {edges.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">No edges (stages run in parallel by default).</p>
      )}

      {edges.map((edge, i) => (
        <div
          key={i}
          className="grid grid-cols-[1fr_auto_1fr_auto] items-end gap-2 rounded border border-[var(--border-subtle)] p-2"
        >
          <div className="flex flex-col gap-1">
            <span className={labelClass}>From stage</span>
            <select
              className={inputClass}
              value={edge.from.stage}
              onChange={(e) =>
                updateEdge(i, { from: { ...edge.from, stage: e.target.value } })
              }
              disabled={disabled}
              aria-label={`Edge ${i + 1} from stage`}
            >
              <option value="">— stage —</option>
              {stageKeys.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <input
              type="text"
              className={inputClass}
              value={edge.from.slot}
              onChange={(e) =>
                updateEdge(i, { from: { ...edge.from, slot: e.target.value } })
              }
              disabled={disabled}
              placeholder="slot name"
              aria-label={`Edge ${i + 1} from slot`}
            />
          </div>

          <span className="pb-2 text-sm text-[var(--text-muted)]">→</span>

          <div className="flex flex-col gap-1">
            <span className={labelClass}>To stage</span>
            <select
              className={inputClass}
              value={edge.to.stage}
              onChange={(e) =>
                updateEdge(i, { to: { ...edge.to, stage: e.target.value } })
              }
              disabled={disabled}
              aria-label={`Edge ${i + 1} to stage`}
            >
              <option value="">— stage —</option>
              {stageKeys.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <input
              type="text"
              className={inputClass}
              value={edge.to.slot}
              onChange={(e) =>
                updateEdge(i, { to: { ...edge.to, slot: e.target.value } })
              }
              disabled={disabled}
              placeholder="slot name"
              aria-label={`Edge ${i + 1} to slot`}
            />
          </div>

          <button
            type="button"
            className={`${dangerBtnClass} mb-0.5`}
            onClick={() => removeEdge(i)}
            disabled={disabled}
            aria-label={`Remove edge ${i + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
