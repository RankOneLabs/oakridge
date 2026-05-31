/**
 * Operator form for launching a new study run.
 *
 * buildRunSpec is exported as a pure helper so it can be unit-tested
 * without a DOM (see pwa/LaunchForm.test.ts). On a successful launch
 * it calls useHashSelection.select(cell_id) to navigate the existing
 * SSE live view to the new cell.
 */
import { useEffect, useState } from "react";

import { useLaunch } from "../../hooks/useLaunch";
import { useHashSelection } from "../../hooks/useHashSelection";
import { CONDITION_KINDS, RunSpecSchema } from "../../lib/types";
import type { ConditionSpec, RunSpec, TaskSummary } from "../../lib/types";

export const KNOWN_MODELS = [
  "claude-sonnet-4-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-haiku-4-5",
  "gpt-5",
  "gpt-5-mini",
] as const;

export interface FormState {
  target: string;
  checkedModels: Set<string>;
  extraModels: string[];
  conditionKind: ConditionSpec["kind"];
  n: number;
  should_grade: boolean;
}

type BuildResult =
  | { ok: true; spec: RunSpec }
  | { ok: false; error: string };

// Known models ordered by KNOWN_MODELS position; extras appended in
// the order they were added (selection order matters: the harness
// assigns agents model_pool[i % len]).
export function buildRunSpec(state: FormState): BuildResult {
  const modelPool = [
    ...KNOWN_MODELS.filter((m) => state.checkedModels.has(m)),
    ...state.extraModels,
  ];
  const result = RunSpecSchema.safeParse({
    task: state.target,
    model_pool: modelPool,
    condition: { kind: state.conditionKind, n: state.n },
    grade: state.should_grade,
  });
  if (result.success) return { ok: true, spec: result.data };
  return {
    ok: false,
    error: result.error.issues[0]?.message ?? "invalid spec",
  };
}

function minNFor(kind: ConditionSpec["kind"]): number {
  return kind === "ensemble_single_round" || kind === "ensemble_multi_round"
    ? 2
    : 1;
}

export function LaunchForm({
  tasks,
  selectedTaskName,
  onSelectTask,
}: {
  tasks: TaskSummary[];
  selectedTaskName: string | null;
  onSelectTask: (name: string | null) => void;
}) {
  const [, select] = useHashSelection();
  const { launch, is_pending, error: launchError } = useLaunch();
  const [warning, setWarning] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [state, setState] = useState<FormState>(() => ({
    target: selectedTaskName ?? "",
    checkedModels: new Set(),
    extraModels: [],
    conditionKind: "single_agent",
    n: 1,
    should_grade: true,
  }));

  useEffect(() => {
    setState((current) =>
      current.target === (selectedTaskName ?? "")
        ? current
        : { ...current, target: selectedTaskName ?? "" },
    );
  }, [selectedTaskName]);

  const result = buildRunSpec(state);

  function toggleModel(model: string) {
    setState((s) => {
      const next = new Set(s.checkedModels);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return { ...s, checkedModels: next };
    });
  }

  function addFreeTextModel() {
    const trimmed = freeText.trim();
    if (!trimmed || state.extraModels.includes(trimmed)) {
      setFreeText("");
      return;
    }
    setState((s) => ({ ...s, extraModels: [...s.extraModels, trimmed] }));
    setFreeText("");
  }

  function removeExtraModel(model: string) {
    setState((s) => ({
      ...s,
      extraModels: s.extraModels.filter((m) => m !== model),
    }));
  }

  function setKind(kind: ConditionSpec["kind"]) {
    setState((s) => {
      let n = s.n;
      if (kind === "single_agent") {
        n = 1;
      } else if (n < minNFor(kind)) {
        n = minNFor(kind);
      }
      return { ...s, conditionKind: kind, n };
    });
  }

  function setN(raw: number) {
    const min = minNFor(state.conditionKind);
    setState((s) => ({ ...s, n: Math.max(min, Math.min(16, raw)) }));
  }

  async function handleLaunch() {
    if (!result.ok) return;
    setWarning(null);
    const response = await launch(result.spec);
    if (response) {
      if (response.warning) setWarning(response.warning);
      select(response.cell_id);
    }
  }

  const minN = minNFor(state.conditionKind);

  return (
    <div className="flex flex-wrap gap-6 px-4 pb-4 pt-2">
      {/* Target */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Task
        </label>
        <select
          className="rounded border border-stone-300 px-2 py-1 text-sm"
          value={selectedTaskName ?? ""}
          onChange={(e) => {
            const next = e.target.value;
            onSelectTask(next === "" ? null : next);
            setState((s) => ({ ...s, target: next }));
          }}
        >
          <option value="">— pick task —</option>
          {tasks.map((task) => (
            <option key={task.name} value={task.name}>
              {task.name}
            </option>
          ))}
        </select>
      </div>

      {/* Models */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Models
        </label>
        <div className="flex flex-col gap-0.5">
          {KNOWN_MODELS.map((m) => (
            <label key={m} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={state.checkedModels.has(m)}
                onChange={() => toggleModel(m)}
              />
              {m}
            </label>
          ))}
        </div>
        {state.extraModels.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            {state.extraModels.map((m) => (
              <div key={m} className="flex items-center gap-1 text-sm">
                <span className="rounded bg-sky-50 px-1.5 py-0.5 text-xs text-sky-700">
                  {m}
                </span>
                <button
                  type="button"
                  aria-label={`Remove model ${m}`}
                  className="text-stone-400 hover:text-red-500"
                  onClick={() => removeExtraModel(m)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="mt-1 flex gap-1">
          <input
            className="w-44 rounded border border-stone-300 px-2 py-1 text-sm"
            placeholder="other model id…"
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); addFreeTextModel(); }
            }}
          />
          <button
            type="button"
            className="rounded bg-stone-100 px-2 py-1 text-xs hover:bg-stone-200"
            onClick={addFreeTextModel}
          >
            Add
          </button>
        </div>
      </div>

      {/* Condition */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Condition
        </label>
        <div className="flex flex-col gap-0.5">
          {CONDITION_KINDS.map((kind) => (
            <label key={kind} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="conditionKind"
                checked={state.conditionKind === kind}
                onChange={() => setKind(kind)}
              />
              {kind}
            </label>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
            n
          </label>
          <input
            type="number"
            min={minN}
            max={16}
            value={state.n}
            disabled={state.conditionKind === "single_agent"}
            onChange={(e) => setN(Number(e.target.value))}
            className="w-16 rounded border border-stone-300 px-2 py-1 text-sm disabled:bg-stone-100 disabled:text-stone-400"
          />
        </div>
      </div>

      {/* Grade */}
      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Grade
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={state.should_grade}
            onChange={(e) =>
              setState((s) => ({ ...s, should_grade: e.target.checked }))
            }
          />
          Run grader
        </label>
      </div>

      {/* Launch */}
      <div className="flex flex-col justify-end gap-1.5">
        {!result.ok && state.target !== "" && (
          <p className="text-xs text-red-500">{result.error}</p>
        )}
        {warning && <p className="text-xs text-amber-600">⚠ {warning}</p>}
        {launchError && <p className="text-xs text-red-500">{launchError}</p>}
        <button
          className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!result.ok || is_pending}
          onClick={() => void handleLaunch()}
        >
          {is_pending ? "Launching…" : "Launch"}
        </button>
      </div>
    </div>
  );
}
