import { useEffect, useState } from "react";

import { generateSlug } from "../../lib/session";
import { PWA_MODEL_OPTIONS } from "../../lib/format";
import {
  NEW_SESSION_MODEL_STORAGE_KEY,
  readStoredNewSessionModel,
} from "../../lib/storage";

export interface NewSessionFormValues {
  workdir: string;
  name: string;
  model: string;
}

export interface NewSessionFormProps {
  defaultWorkdir: string;
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
  const [modelInput, setModelInput] = useState<string>(readStoredNewSessionModel);
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
    if (defaultWorkdir && workdirInput === "") {
      setWorkdirInput(defaultWorkdir);
    }
  }, [defaultWorkdir, workdirInput, workdirTouched]);

  useEffect(() => {
    try {
      localStorage.setItem(NEW_SESSION_MODEL_STORAGE_KEY, modelInput);
    } catch {}
  }, [modelInput]);

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
            model: modelInput,
          });
        }}
      >
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
        <select
          className="new-session-model"
          value={modelInput}
          onChange={(e) => setModelInput(e.target.value)}
          disabled={pending}
          aria-label="Model for new session"
        >
          {PWA_MODEL_OPTIONS.map((opt) => (
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
