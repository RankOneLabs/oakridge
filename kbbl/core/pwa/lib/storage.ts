import type { Theme } from "../types";
import type { RuntimeDescriptor } from "../types";

export const THEME_STORAGE_KEY = "oakridge.theme";
/**
 * @deprecated Use runtimeId-namespaced keys via newSessionModelKey().
 * Kept for the migration read path so existing stored values are preserved.
 */
export const NEW_SESSION_MODEL_STORAGE_KEY = "oakridge.newSessionModel";

/**
 * Returns the localStorage key for per-runtime model preference.
 * Format: `kbbl.newSession.model.<runtimeId>` (e.g.
 * `kbbl.newSession.model.claude-code`).
 */
export function newSessionModelKey(runtimeId: string): string {
  return `kbbl.newSession.model.${runtimeId}`;
}

export function isValidNewSessionModelForRuntime(
  value: string,
  runtime: RuntimeDescriptor,
): boolean {
  if (value === "") return true;
  return runtime.models.some((o) => o.value === value);
}

export function defaultNewSessionModelForRuntime(runtime: RuntimeDescriptor): string {
  // First-mount default: cost-engineering nudge per the design doc —
  // make sonnet the implicit choice so absent-minded "+ New" clicks
  // route to Sonnet pricing.
  if (
    runtime.id === "claude-code" &&
    runtime.models.some((o) => o.value === "claude-sonnet-4-6")
  ) {
    return "claude-sonnet-4-6";
  }
  return "";
}

export function normalizeNewSessionModelForRuntime(
  value: string,
  runtime: RuntimeDescriptor,
): string {
  if (isValidNewSessionModelForRuntime(value, runtime)) return value;
  return defaultNewSessionModelForRuntime(runtime);
}

/**
 * Read the stored model for the given runtime. Falls back to the legacy
 * un-namespaced key so existing stored values are preserved on first access
 * after the migration.
 */
export function readStoredNewSessionModel(runtime: RuntimeDescriptor): string {
  try {
    const namespacedKey = newSessionModelKey(runtime.id);
    const namespaced = localStorage.getItem(namespacedKey);
    if (
      namespaced !== null &&
      isValidNewSessionModelForRuntime(namespaced, runtime)
    ) {
      return namespaced;
    }
    // Migration: read legacy key once, migrate to namespaced key.
    const legacy = localStorage.getItem(NEW_SESSION_MODEL_STORAGE_KEY);
    if (
      legacy !== null &&
      isValidNewSessionModelForRuntime(legacy, runtime)
    ) {
      try { localStorage.setItem(namespacedKey, legacy); } catch {}
      return legacy;
    }
  } catch {}
  return defaultNewSessionModelForRuntime(runtime);
}

/**
 * Write the stored model for the given runtime.
 */
export function writeStoredNewSessionModel(value: string, runtime: RuntimeDescriptor): string {
  const normalized = normalizeNewSessionModelForRuntime(value, runtime);
  try {
    localStorage.setItem(
      newSessionModelKey(runtime.id),
      normalized,
    );
  } catch {}
  return normalized;
}

export function readStoredTheme(): Theme {
  // SSR-safe guard; also swallows SecurityError from sandboxed localStorage.
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "dark";
}
