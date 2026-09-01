import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import type { UiSessionConfig } from "../../types";
import { groupConfigOptions } from "../../lib/acp-timeline";

// Session config selectors (§12.3), rendered generically from the
// agent's config options: model / thought_level / mode get named slots,
// unknown select categories land in the same strip. The agent's option
// order is authoritative; the new value shows once the agent's
// config_option_update round-trips through the stream.
export function SessionConfigBar({
  sid,
  options,
  disabled,
}: {
  sid: string;
  options: readonly UiSessionConfig[];
  disabled: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: async (payload: { config_id: string; value: string | boolean }) => {
      const res = await fetch(`/sessions/${encodeURIComponent(sid)}/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
        } | null;
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : `server returned ${res.status}`,
        );
      }
    },
  });

  if (options.length === 0) return null;
  const grouped = groupConfigOptions(options);
  const ordered = [
    grouped.model,
    grouped.thoughtLevel,
    grouped.mode,
    ...grouped.overflow,
  ].filter((option): option is UiSessionConfig => option !== null);

  async function apply(configId: string, value: string | boolean) {
    setError(null);
    try {
      await mutation.mutateAsync({ config_id: configId, value });
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    }
  }

  return (
    <div className="session-config-bar">
      {ordered.map((option) =>
        option.type === "select" ? (
          <label key={option.id} className="session-config-item" title={option.name}>
            <span className="session-config-label">{option.name}</span>
            <select
              value={typeof option.value === "string" ? option.value : ""}
              disabled={disabled || mutation.isPending}
              onChange={(e) => void apply(option.id, e.target.value)}
            >
              {option.options.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label key={option.id} className="session-config-item" title={option.name}>
            <span className="session-config-label">{option.name}</span>
            <input
              type="checkbox"
              checked={option.value === true}
              disabled={disabled || mutation.isPending}
              onChange={(e) => void apply(option.id, e.target.checked)}
            />
          </label>
        ),
      )}
      {error && (
        <span className="session-config-error" role="alert" title={error}>
          ⚠ {error}
        </span>
      )}
    </div>
  );
}
