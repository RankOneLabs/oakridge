import type React from "react";
import { useEffect, useState } from "react";

import type { Task, PermissionProfile } from "../../../safir/types";
import { generateSlug, toPositiveSafeInt } from "../../lib/session";
import { PWA_MODEL_OPTIONS } from "../../lib/format";
import {
  NEW_SESSION_MODEL_STORAGE_KEY,
  readStoredNewSessionModel,
} from "../../lib/storage";

export interface NewSessionFormValues {
  workdir: string;
  name: string;
  model: string;
  taskId: number | null;
  profileId: number | null;
}

export interface NewSessionFormProps {
  tasks: Task[];
  profiles: PermissionProfile[];
  defaultWorkdir: string;
  initialWorkdir: string;
  initialTaskId: string;
  initialProfileId: string;
  workdirTouchedInitial: boolean;
  profileLockedRef: React.MutableRefObject<boolean>;
  pending: boolean;
  pendingError: string | null;
  autostartPending: boolean;
  onAutostartConsumed: () => void;
  resetSignal: number;
  onSubmit: (values: NewSessionFormValues) => void;
}

export function NewSessionForm({
  tasks,
  profiles,
  defaultWorkdir,
  initialWorkdir,
  initialTaskId,
  initialProfileId,
  workdirTouchedInitial,
  profileLockedRef,
  pending,
  pendingError,
  autostartPending,
  onAutostartConsumed,
  resetSignal,
  onSubmit,
}: NewSessionFormProps) {
  const [workdirInput, setWorkdirInput] = useState(initialWorkdir);
  const [workdirTouched, setWorkdirTouched] = useState(workdirTouchedInitial);
  const [nameInput, setNameInput] = useState("");
  const [modelInput, setModelInput] = useState<string>(readStoredNewSessionModel);
  // Generated once per mount so the placeholder is stable while the operator
  // is filling out the form (otherwise it would flicker on every re-render).
  // Submit uses the current placeholder if name field is empty, so what they
  // see is what they get.
  const [namePlaceholder, setNamePlaceholder] = useState(generateSlug);
  const [taskInput, setTaskInput] = useState(initialTaskId);
  const [profileInput, setProfileInput] = useState(initialProfileId);

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
    if (profileLockedRef.current) return;
    if (taskInput === "") {
      setProfileInput("");
      return;
    }
    const task = tasks.find((t) => String(t.id) === taskInput);
    if (!task) return;
    setProfileInput(
      task.default_permission_profile_id != null
        ? String(task.default_permission_profile_id)
        : "",
    );
  }, [taskInput, tasks, profileLockedRef]);

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
        taskId: toPositiveSafeInt(taskInput || null),
        profileId: toPositiveSafeInt(profileInput || null),
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
            taskId: toPositiveSafeInt(taskInput || null),
            profileId: toPositiveSafeInt(profileInput || null),
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
          className="new-session-task"
          value={taskInput}
          onChange={(e) => setTaskInput(e.target.value)}
          disabled={pending}
          aria-label="Bind session to safir task (optional)"
        >
          <option value="">no task (free session)</option>
          {tasks.map((t) => (
            <option key={t.id} value={String(t.id)}>
              #{t.id} {t.title}
            </option>
          ))}
        </select>
        <select
          className="new-session-profile"
          value={profileInput}
          onChange={(e) => {
            setProfileInput(e.target.value);
            profileLockedRef.current = true;
          }}
          disabled={pending}
          aria-label="Permission profile (optional)"
        >
          <option value="">use built-in default</option>
          {profiles.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.name}
              {p.is_seed ? " (seed)" : ""}
            </option>
          ))}
        </select>
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
