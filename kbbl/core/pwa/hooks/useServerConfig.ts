import { useQuery } from "@tanstack/react-query";
import type { RuntimeId } from "../../runtime-interface";
import type { RuntimeDescriptor, RuntimeModelOption } from "../types";
import { PWA_MODEL_OPTIONS } from "../lib/format";

interface ServerConfigResponse {
  defaultWorkdir: string;
  softThresholdTokens?: number;
  defaultRuntimeId?: string;
  runtimes?: unknown;
}

export interface ServerConfig {
  defaultWorkdir: string;
  softThresholdTokens?: number;
  defaultRuntimeId: RuntimeId;
  runtimes: RuntimeDescriptor[];
}

function isRuntimeId(value: unknown): value is RuntimeId {
  return value === "claude-code" || value === "codex";
}

function fallbackClaudeDescriptor(): RuntimeDescriptor {
  return {
    id: "claude-code",
    label: "Claude Code",
    models: PWA_MODEL_OPTIONS.filter((o) => o.value !== "").map((o) => ({
      value: o.value,
      label: o.label,
    })),
    supportsCompaction: true,
  };
}

function coerceRuntimeModels(value: unknown): RuntimeModelOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const model = raw as { value?: unknown; label?: unknown };
    if (typeof model.value !== "string") return [];
    return [{
      value: model.value,
      label: typeof model.label === "string" ? model.label : model.value,
    }];
  });
}

function coerceRuntimeDescriptors(value: unknown): [RuntimeDescriptor, ...RuntimeDescriptor[]] {
  if (!Array.isArray(value)) return [fallbackClaudeDescriptor()];
  const runtimes = value.flatMap((raw) => {
    if (typeof raw !== "object" || raw === null) return [];
    const runtime = raw as {
      id?: unknown;
      label?: unknown;
      models?: unknown;
      supportsCompaction?: unknown;
    };
    if (!isRuntimeId(runtime.id)) return [];
    return [{
      id: runtime.id,
      label: typeof runtime.label === "string" ? runtime.label : runtime.id,
      models: coerceRuntimeModels(runtime.models),
      supportsCompaction: runtime.supportsCompaction === true,
    }];
  });
  if (runtimes.length === 0) return [fallbackClaudeDescriptor()];
  const [first, ...rest] = runtimes;
  return [first, ...rest];
}

/**
 * Fetches the server's /config once. Returns null until the fetch resolves
 * so callers can render a "loading" placeholder rather than racing forms
 * with empty defaults. Cached indefinitely — the server's config doesn't
 * change mid-session, and SessionTopBar's PATCH /config invalidates this
 * query so the next read reflects the server response.
 */
export function useServerConfig(): ServerConfig | null {
  const query = useQuery({
    queryKey: ["config"],
    queryFn: async (): Promise<ServerConfigResponse> => {
      const res = await fetch("/config");
      if (!res.ok) throw new Error(`config: ${res.status}`);
      return (await res.json()) as ServerConfigResponse;
    },
    staleTime: Infinity,
  });
  if (!query.data) return null;
  const rawId = query.data.defaultRuntimeId;
  const runtimes = coerceRuntimeDescriptors(query.data.runtimes);
  const defaultRuntimeId = isRuntimeId(rawId) ? rawId : "claude-code";
  return {
    defaultWorkdir: query.data.defaultWorkdir,
    softThresholdTokens:
      typeof query.data.softThresholdTokens === "number"
        ? query.data.softThresholdTokens
        : undefined,
    defaultRuntimeId: runtimes.some((r) => r.id === defaultRuntimeId)
      ? defaultRuntimeId
      : runtimes[0].id,
    runtimes,
  };
}
