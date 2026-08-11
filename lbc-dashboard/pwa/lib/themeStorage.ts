import type { Result } from "./result";

export type DashboardTheme = "light" | "dark";

export interface ThemeStorageError {
  operation: "read-theme" | "write-theme";
  key: "lbc-dashboard.theme";
  detail: string;
}

export const THEME_STORAGE_KEY = "lbc-dashboard.theme";

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readStoredTheme(
  storage: Pick<Storage, "getItem">,
): Result<DashboardTheme | null, ThemeStorageError> {
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return {
      ok: true,
      value: value === "light" || value === "dark" ? value : null,
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        operation: "read-theme",
        key: THEME_STORAGE_KEY,
        detail: errorDetail(error),
      },
    };
  }
}

export function writeStoredTheme(
  storage: Pick<Storage, "setItem">,
  theme: DashboardTheme,
): Result<void, ThemeStorageError> {
  try {
    storage.setItem(THEME_STORAGE_KEY, theme);
    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: {
        operation: "write-theme",
        key: THEME_STORAGE_KEY,
        detail: errorDetail(error),
      },
    };
  }
}
