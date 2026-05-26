import { useEffect, useState } from "react";

import type { RuntimeId } from "../../../runtime-interface";
import type { RuntimeDescriptor } from "../../types";
import { generateSlug } from "../../lib/session";
import {
  readStoredNewSessionModel,
  writeStoredNewSessionModel,
} from "../../lib/storage";
import { DirectoryPicker } from "./DirectoryPicker";

export interface NewSessionFormValues {
  workdir: string;
  name: string;
  runtimeId: RuntimeId;
  model: string;
}

export interface NewSessionFormProps {
  defaultWorkdir: string | null;
  defaultRuntimeId: RuntimeId;
  runtimes: RuntimeDescriptor[];
  initialWorkdir: string | null;
  workdirTouchedInitial: boolean;
  pending: boolean;
  pendingError: string | null;
  autostartPending: boolean;
  onAutostartConsumed: () => void;
  resetSignal: number;
  onSubmit: (values: NewSessionFormValues) => void;
}

export function NewSessionForm({
  defaultWorkdir,
  defaultRuntimeId,
  runtimes,
  initialWorkdir,
  workdirTouchedInitial,
  pending,
  pendingError,
  autostartPending,
  onAutostartConsumed,
  resetSignal,
  onSubmit,
}: NewSessionFormProps) {
  const [workdirInput, setWorkdirInput] = useState(initialWorkdir ?? "");
  const [workdirTouched, setWorkdirTouched] = useState(workdirTouchedInitial);
  const [nameInput, setNameInput] = useState("");
  const [runtimeId, setRuntimeId] = useState<RuntimeId>(defaultRuntimeId);
  const selectedRuntime =
    runtimes.find((r) => r.id === runtimeId) ??
    runtimes.find((r) => r.id === defaultRuntimeId) ??
    runtimes[0];
  const [modelInput, setModelInput] = useState<string>(() => {
    const runtime =
      runtimes.find((r) => r.id === defaultRuntimeId) ??
      runtimes[0];
    return runtime ? readStoredNewSessionModel(runtime) : "";
  });

  useEffect(() => {
    setRuntimeId(defaultRuntimeId);
  }, [defaultRuntimeId]);

  useEffect(() => {
    if (!selectedRuntime) return;
    setRuntimeId(selectedRuntime.id);
    setModelInput(readStoredNewSessionModel(selectedRuntime));
  }, [selectedRuntime?.id]);

  // Generated once per mount so the placeholder is stable while the operator
  // is filling out the form (otherwise it would flicker on every re-render).
  // Submit uses the current placeholder if name field is empty, so what they
  // see is what they get.
  const [namePlaceholder, setNamePlaceholder] = useState(generateSlug);

  // Prefill the workdir input with the server default once /config resolves,
  // but only if the operator hasn't typed anything yet — otherwise a slow
  // /config response would clobber what they were mid-typing. workdirTouched
  // also prevents re-prefilling after the operator deliberately cleared it.
  useEffect(() => {
    if (workdirTouched) return;
    if (defaultWorkdir !== null && workdirInput === "") {
      setWorkdirInput(defaultWorkdir);
    }
  }, [defaultWorkdir, workdirInput, workdirTouched]);

  useEffect(() => {
    if (resetSignal === 0) return;
    setNameInput("");
    setNamePlaceholder(generateSlug());
  }, [resetSignal]);

  useEffect(() => {
    if (!autostartPending) return;
    if (workdirInput.trim() === "") return;
    // Consume the flag inside the timer, AFTER submit. Flipping
    // autostartPending=false synchronously here would change this effect's
    // deps and trigger its cleanup before the timer elapsed, cancelling the
    // submit.
    const timer = setTimeout(() => {
      onSubmit({
        workdir: workdirInput.trim(),
        name: nameInput.trim() || namePlaceholder,
        runtimeId,
        model: modelInput,
      });
      onAutostartConsumed();
    }, 100);
    return () => clearTimeout(timer);
  }, [autostartPending, workdirInput]); // narrow deps intentional — other values captured at render time

  return (
    <>
      <form
        className="new-session-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            workdir: workdirInput.trim(),
            name: nameInput.trim() || namePlaceholder,
            runtimeId,
            model: modelInput,
          });
        }}
      >
        <div className="new-session-workdir-row">
          <input
            type="text"
            className="new-session-workdir"
            placeholder="/absolute/path/to/workdir"
            value={workdirInput}
            onChange={(e) => {
              setWorkdirInput(e.target.value);
              setWorkdirTouched(true);
            }}
            disabled={pending}
            required
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Workdir for new session"
          />
          <DirectoryPicker
            disabled={pending}
            initialPath={workdirInput.trim() || defaultWorkdir}
            onSelect={(path) => {
              setWorkdirInput(path);
              setWorkdirTouched(true);
            }}
          />
        </div>
        {runtimes.length > 1 && (
          <select
            className="new-session-runtime"
            value={runtimeId}
            onChange={(e) => {
              const nextRuntimeId = e.target.value as RuntimeId;
              const nextRuntime = runtimes.find((runtime) => runtime.id === nextRuntimeId);
              setRuntimeId(nextRuntimeId);
              if (nextRuntime) {
                setModelInput(readStoredNewSessionModel(nextRuntime));
              }
            }}
            disabled={pending}
            aria-label="Runtime for new session"
          >
            {runtimes.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {runtime.label}
              </option>
            ))}
          </select>
        )}
        <select
          className="new-session-model"
          value={modelInput}
          onChange={(e) => {
            const nextModel = e.target.value;
            if (!selectedRuntime) {
              setModelInput(nextModel);
              return;
            }
            setModelInput(writeStoredNewSessionModel(nextModel, selectedRuntime));
          }}
          disabled={pending}
          aria-label="Model for new session"
        >
          {[{ value: "", label: "default" }, ...(selectedRuntime?.models ?? [])].map((opt) => (
            <option key={opt.value || "default"} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          className="new-session-name"
          placeholder={namePlaceholder}
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          disabled={pending}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          maxLength={80}
          aria-label="Optional session name"
          title="Leave blank to use the generated name shown as placeholder"
        />
        <button
          type="submit"
          className="btn-new-session"
          disabled={pending || workdirInput.trim() === ""}
        >
          {pending ? "starting…" : "+ New"}
        </button>
      </form>
      {pendingError && (
        <div className="input-error" role="alert">
          error: {pendingError}
        </div>
      )}
    </>
  );
}
