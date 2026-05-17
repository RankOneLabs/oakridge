import type { Theme } from "../types";
import { PWA_MODEL_OPTIONS } from "./format";

export const THEME_STORAGE_KEY = "oakridge.theme";
export const NEW_SESSION_MODEL_STORAGE_KEY = "oakridge.newSessionModel";

export function readStoredNewSessionModel(): string {
  try {
    const v = localStorage.getItem(NEW_SESSION_MODEL_STORAGE_KEY);
    if (v !== null && PWA_MODEL_OPTIONS.some((o) => o.value === v)) {
      return v;
    }
  } catch {}
  // First-mount default: cost-engineering nudge per the design doc —
  // make sonnet the implicit choice so absent-minded "+ New" clicks
  // route to Sonnet pricing.
  return "claude-sonnet-4-6";
}

export function readStoredTheme(): Theme {
  // SSR-safe guard; also swallows SecurityError from sandboxed localStorage.
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "dark";
}
