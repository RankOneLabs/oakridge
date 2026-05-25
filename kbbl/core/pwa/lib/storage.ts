import type { Theme } from "../types";
import { PWA_MODEL_OPTIONS } from "./format";

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

/**
 * Read the stored model for the given runtime. Falls back to the legacy
 * un-namespaced key so existing stored values are preserved on first access
 * after the migration.
 */
export function readStoredNewSessionModel(runtimeId = "claude-code"): string {
  try {
    const namespacedKey = newSessionModelKey(runtimeId);
    const namespaced = localStorage.getItem(namespacedKey);
    if (namespaced !== null && PWA_MODEL_OPTIONS.some((o) => o.value === namespaced)) {
      return namespaced;
    }
    // Migration: read legacy key once, migrate to namespaced key.
    const legacy = localStorage.getItem(NEW_SESSION_MODEL_STORAGE_KEY);
    if (legacy !== null && PWA_MODEL_OPTIONS.some((o) => o.value === legacy)) {
      try { localStorage.setItem(namespacedKey, legacy); } catch {}
      return legacy;
    }
  } catch {}
  // First-mount default: cost-engineering nudge per the design doc —
  // make sonnet the implicit choice so absent-minded "+ New" clicks
  // route to Sonnet pricing.
  return "claude-sonnet-4-6";
}

/**
 * Write the stored model for the given runtime.
 */
export function writeStoredNewSessionModel(value: string, runtimeId = "claude-code"): void {
  try {
    localStorage.setItem(newSessionModelKey(runtimeId), value);
  } catch {}
}

export function readStoredTheme(): Theme {
  // SSR-safe guard; also swallows SecurityError from sandboxed localStorage.
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "dark";
}
