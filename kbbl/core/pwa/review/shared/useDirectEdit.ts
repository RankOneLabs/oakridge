import { useState } from "react";
import type { ArtifactTarget } from "./types";

export interface DirectEditResult {
  saving: boolean;
  error: string | null;
  save: (anchor: string, prevValue: string | null, newValue: string) => Promise<boolean>;
  clearError: () => void;
}

export function useDirectEdit(target: ArtifactTarget): DirectEditResult {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(anchor: string, prevValue: string | null, newValue: string): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/safir/atoms/${encodeURIComponent(target.type)}/${encodeURIComponent(target.id)}/edits`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ anchor, prev_value: prevValue, new_value: newValue, edited_by: "operator" }),
        },
      );
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { current_value?: string; error?: string };
        const current = body.current_value ?? "(unknown)";
        setError(`Edit conflict on ${anchor}: current value is ${current}`);
        setSaving(false);
        return false;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `save failed (HTTP ${res.status})`);
        setSaving(false);
        return false;
      }
      setSaving(false);
      return true;
    } catch (e) {
      setError(String(e));
      setSaving(false);
      return false;
    }
  }

  return { saving, error, save, clearError: () => setError(null) };
}
